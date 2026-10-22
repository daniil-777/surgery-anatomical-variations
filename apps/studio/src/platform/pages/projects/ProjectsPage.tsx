// #/projects[?lab=…]: every project of the account (APPLE_STYLE_SPEC §3.3) — a 16:10 grid or a sortable list, a lab
// scope, search, favourites, inline rename, duplicate and Move to Trash with Undo. "New Project" opens a lab without a
// project (#/lab/<id>); its "Save as Project…" creates the project.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  ArrowUpDown,
  Copy,
  Droplet,
  Droplets,
  Ellipsis,
  FlaskConical,
  FolderClosed,
  FolderOpen,
  Heart,
  Layers,
  LayoutGrid,
  List,
  PencilLine,
  PersonStanding,
  Plus,
  Search,
  Shapes,
  SwatchBook,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { useAuth, useBackend } from "../../app/context";
import { invalidate, setQueryData, useQuery } from "../../app/query";
import { navigate } from "../../app/router";
import { getLab, listLabs, type LabDefinition } from "../../core/labs/registry";
import type { Project } from "../../core/types";
import {
  Button,
  EmptyState,
  Icon,
  IconButton,
  MediaCard,
  MediaGrid,
  Menu,
  MenuButton,
  MenuItem,
  MenuSeparator,
  PopUpButton,
  SearchField,
  SegmentedControl,
  Skeleton,
  Toolbar,
  ToolbarGroup,
  ToolbarItem,
  cssVars,
  cx,
  formatCount,
  pointReference,
  useToast,
} from "../../ui";
import { friendlyError } from "../../components/lab/friendlyError";
import { useAssetUrl } from "../../components/lab/hooks";
import {
  PROJECT_SORTS,
  cleanProjectTitle,
  copyTitle,
  editedAt,
  filterProjects,
  projectSubtitle,
  relativeTime,
  sortProjects,
  type ProjectSort,
  type ProjectView,
} from "./projectList";
import "./projects.css";

export interface ProjectsPageProps {
  lab?: string | undefined;
}

export const PROJECTS_LIST_KEY = "projects:list";
const PREFS_KEY = "viscera.px.projects.v1";

const LAB_ICONS: Readonly<Record<string, LucideIcon>> = { Shapes, SwatchBook, PersonStanding, Layers, Droplet, Droplets };

export function labIcon(lab: LabDefinition | null): LucideIcon {
  return (lab && LAB_ICONS[lab.icon]) || FlaskConical;
}

interface Prefs {
  view: ProjectView;
  sort: ProjectSort;
}

function readPrefs(): Prefs {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<Prefs>;
    return {
      view: parsed.view === "list" ? "list" : "grid",
      sort: parsed.sort === "name" || parsed.sort === "created" ? parsed.sort : "recent",
    };
  } catch {
    return { view: "grid", sort: "recent" };
  }
}

function writePrefs(prefs: Prefs): void {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // a per-viewer convenience only
  }
}

/** Labs a new project can start in (their session adapter saves projects). */
function projectLabs(): LabDefinition[] {
  return listLabs().filter((lab) => lab.capabilities.projects);
}

type MenuTarget = { project: Project; anchor: HTMLElement | ReturnType<typeof pointReference>; returnTo: HTMLElement | null };
type RenameTarget = { project: Project; anchor: HTMLElement | null };

export default function ProjectsPage({ lab: labFilter }: ProjectsPageProps) {
  const backend = useBackend();
  const auth = useAuth();
  const toast = useToast();
  const signedIn = auth.status === "signed-in";
  const { data, error, loading, refresh } = useQuery(signedIn ? PROJECTS_LIST_KEY : null, () => backend.projects.list({ orderBy: "updated" }));
  const [prefs, setPrefsState] = useState<Prefs>(readPrefs);
  const [search, setSearch] = useState("");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const [renaming, setRenaming] = useState<RenameTarget | null>(null);
  const now = new Date();

  const setPrefs = (patch: Partial<Prefs>) => {
    setPrefsState((current) => {
      const next = { ...current, ...patch };
      writePrefs(next);
      return next;
    });
  };

  const scopedLab = labFilter ? getLab(labFilter) : null;
  const all = useMemo(() => (data ?? []).filter((project) => project.trashedAt === null), [data]);
  const visible = useMemo(
    () => sortProjects(filterProjects(all, { labId: labFilter, favoritesOnly, search }), prefs.sort),
    [all, labFilter, favoritesOnly, search, prefs.sort],
  );
  const creatable = projectLabs();
  // scope tabs: labs that save projects plus any lab an existing project belongs to
  const scopeLabs = useMemo(() => {
    const ids = new Set([...creatable.map((lab) => lab.id), ...all.map((project) => project.labId)]);
    return [...ids].map((id) => getLab(id)).filter((lab): lab is LabDefinition => lab !== null);
  }, [all, creatable]);

  // drop selections of projects that are no longer listed
  useEffect(() => {
    setSelected((current) => {
      const ids = new Set(visible.map((project) => project.id));
      const next = new Set([...current].filter((id) => ids.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [visible]);

  const byId = useCallback((id: string) => all.find((project) => project.id === id) ?? null, [all]);

  const patchLocal = (id: string, patch: Partial<Project>) =>
    setQueryData<Project[]>(PROJECTS_LIST_KEY, (current) => (current ?? []).map((project) => (project.id === id ? { ...project, ...patch } : project)));

  const open = (id: string) => navigate({ name: "project", id });

  const setFavorite = async (ids: string[], favorite: boolean) => {
    for (const id of ids) patchLocal(id, { favorite });
    try {
      await Promise.all(ids.map((id) => backend.projects.update(id, { favorite })));
    } catch (reason) {
      for (const id of ids) patchLocal(id, { favorite: !favorite });
      toast.show({ message: friendlyError(reason, "Favorites couldn't be updated."), tone: "error" });
    }
  };

  const toggleFavorites = (ids: string[]) => {
    const projects = ids.map(byId).filter((project): project is Project => project !== null);
    if (projects.length === 0) return;
    // like Photos: if any is not a favourite, all become favourites
    void setFavorite(projects.map((project) => project.id), projects.some((project) => !project.favorite));
  };

  const rename = async (project: Project, title: string) => {
    const clean = cleanProjectTitle(title);
    if (!clean || clean === project.title) return;
    patchLocal(project.id, { title: clean });
    try {
      await backend.projects.update(project.id, { title: clean });
    } catch (reason) {
      patchLocal(project.id, { title: project.title });
      toast.show({ message: friendlyError(reason, "The project couldn't be renamed."), tone: "error" });
    }
  };

  const duplicate = async (project: Project) => {
    try {
      const copy = await backend.projects.duplicate(project.id, copyTitle(project.title, all.map((item) => item.title)));
      setQueryData<Project[]>(PROJECTS_LIST_KEY, (current) => [copy, ...(current ?? [])]);
      setSelected(new Set([copy.id]));
      invalidate("projects");
      toast.show({ message: `Duplicated as “${copy.title}”.`, tone: "success", action: { label: "Open", onAction: () => open(copy.id) } });
    } catch (reason) {
      toast.show({ message: friendlyError(reason, "The project couldn't be duplicated."), tone: "error" });
    }
  };

  const moveToTrash = async (ids: string[]) => {
    const projects = ids.map(byId).filter((project): project is Project => project !== null);
    if (projects.length === 0) return;
    const removed = new Set(projects.map((project) => project.id));
    setQueryData<Project[]>(PROJECTS_LIST_KEY, (current) => (current ?? []).filter((project) => !removed.has(project.id)));
    try {
      await Promise.all(projects.map((project) => backend.projects.update(project.id, { trashed: true })));
      invalidate("trash");
      toast.show({
        message: projects.length === 1 ? `Moved “${projects[0]?.title ?? ""}” to the Trash.` : `Moved ${projects.length} projects to the Trash.`,
        tone: "info",
        action: {
          label: "Undo",
          onAction: () => {
            void Promise.all(projects.map((project) => backend.projects.update(project.id, { trashed: false }))).then(
              () => {
                invalidate("projects");
                invalidate("trash");
              },
              (reason: unknown) => toast.show({ message: friendlyError(reason, "Couldn't put the projects back."), tone: "error" }),
            );
          },
        },
      });
    } catch (reason) {
      void refresh();
      toast.show({ message: friendlyError(reason, "Couldn't move to the Trash."), tone: "error" });
    }
  };

  const showMenu = (project: Project, anchor: MenuTarget["anchor"], returnTo: HTMLElement | null) => {
    if (!selected.has(project.id)) setSelected(new Set([project.id]));
    setMenu({ project, anchor, returnTo });
  };

  const onGridContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    const option = (event.target as HTMLElement).closest<HTMLElement>('[role="option"][data-id]');
    const project = option?.dataset.id ? byId(option.dataset.id) : null;
    if (!project) return;
    event.preventDefault();
    showMenu(project, pointReference(event.clientX, event.clientY), option);
  };

  const onGridKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!((event.key === "F10" && event.shiftKey) || event.key === "ContextMenu")) return;
    const option = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[role="option"][data-id]');
    const project = option?.dataset.id ? byId(option.dataset.id) : null;
    if (!project || !option) return;
    event.preventDefault();
    const rect = option.getBoundingClientRect();
    showMenu(project, pointReference(rect.left + 16, rect.bottom - 40), option);
  };

  const newProjectMenu = (
    <>
      {creatable.map((lab) => (
        <MenuItem key={lab.id} icon={labIcon(lab)} onSelect={() => navigate({ name: "lab", labId: lab.id })}>
          {lab.title}
        </MenuItem>
      ))}
    </>
  );

  const newButton = scopedLab?.capabilities.projects ? (
    <Button variant="borderedProminent" size="toolbar" icon={Plus} onClick={() => navigate({ name: "lab", labId: scopedLab.id })}>
      New {scopedLab.title} Project
    </Button>
  ) : (
    <MenuButton variant="borderedProminent" size="toolbar" icon={Plus} placement="bottom-end" menu={newProjectMenu} aria-disabled={creatable.length === 0 || undefined}>
      New Project
    </MenuButton>
  );

  const title = scopedLab ? scopedLab.title : "Projects";
  const subtitle = data ? formatCount(visible.length, "Project") : undefined;

  let content: ReactNode;
  if (!signedIn) {
    content = <EmptyState icon={FolderClosed} title="Sign In to See Your Projects" description="Projects are saved to your account." />;
  } else if (error && !data) {
    content = (
      <EmptyState
        icon={FolderClosed}
        title="Couldn't Load Projects"
        description={friendlyError(error, "Check your connection and try again.")}
        action={
          <Button size="large" onClick={() => void refresh()}>
            Try Again
          </Button>
        }
      />
    );
  } else if (!data && loading) {
    content = <ProjectsSkeleton view={prefs.view} />;
  } else if (visible.length === 0) {
    content = <ProjectsEmpty total={all.length} search={search} favoritesOnly={favoritesOnly} lab={scopedLab} newProjectMenu={newProjectMenu} hasCreatable={creatable.length > 0} />;
  } else if (prefs.view === "grid") {
    content = (
      <div className="px-projects__grid" onContextMenu={onGridContextMenu} onKeyDownCapture={onGridKeyDown}>
        <MediaGrid
          aria-label={title}
          selected={selected}
          onSelectionChange={setSelected}
          onOpen={open}
          onToggleFavorite={toggleFavorites}
          onDelete={(ids) => void moveToTrash(ids)}
          tileMin={220}
        >
          {visible.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              now={now}
              onFavorite={(favorite) => void setFavorite([project.id], favorite)}
              onMore={(anchor) => showMenu(project, anchor, anchor)}
            />
          ))}
        </MediaGrid>
      </div>
    );
  } else {
    content = (
      <ProjectsTable
        projects={visible}
        sort={prefs.sort}
        onSort={(sort) => setPrefs({ sort })}
        selected={selected}
        onSelect={(id) => setSelected(new Set([id]))}
        onOpen={open}
        onFavorite={(project) => void setFavorite([project.id], !project.favorite)}
        onMenu={(project, anchor) => showMenu(project, anchor, anchor)}
        renamingId={renaming?.project.id ?? null}
        onRename={(project, value) => {
          setRenaming(null);
          void rename(project, value);
        }}
        onRenameCancel={() => setRenaming(null)}
        now={now}
      />
    );
  }

  return (
    <div className="px-projects">
      <Toolbar
        className="px-projects__toolbar"
        title={title}
        subtitle={subtitle}
        centerPriority={2}
        center={
          <SegmentedControl<ProjectView>
            aria-label="View"
            variant="toolbar"
            iconOnly
            value={prefs.view}
            onChange={(view) => setPrefs({ view })}
            items={[
              { value: "grid", label: "Grid", icon: LayoutGrid },
              { value: "list", label: "List", icon: List },
            ]}
          />
        }
        trailing={
          <>
            <ToolbarGroup aria-label="Filter" priority={3}>
              <IconButton
                icon={Heart}
                label={favoritesOnly ? "Show All Projects" : "Show Favorites Only"}
                variant="toolbar"
                size="toolbar"
                pressed={favoritesOnly}
                onClick={() => setFavoritesOnly(!favoritesOnly)}
              />
            </ToolbarGroup>
            <ToolbarItem priority={3}>
              <PopUpButton<ProjectSort>
                label="Sort By"
                variant="glass"
                size="toolbar"
                value={prefs.sort}
                onChange={(sort) => setPrefs({ sort })}
                options={PROJECT_SORTS.map((option) => ({ ...option, icon: ArrowUpDown }))}
              />
            </ToolbarItem>
            <ToolbarItem priority={2}>
              <SearchField label="Search Projects" variant="toolbar" value={search} onChange={setSearch} focusShortcut="mod+f" />
            </ToolbarItem>
            {signedIn ? newButton : null}
          </>
        }
      />
      {signedIn && scopeLabs.length > 1 ? (
        <div className="px-projects__scope">
          <SegmentedControl<string>
            aria-label="Lab"
            value={labFilter ?? "all"}
            onChange={(value) => navigate({ name: "projects", ...(value === "all" ? {} : { lab: value }) }, { replace: true })}
            items={[{ value: "all", label: "All Labs" }, ...scopeLabs.map((lab) => ({ value: lab.id, label: lab.title }))]}
          />
        </div>
      ) : null}
      <div className="px-projects__content">{content}</div>

      <Menu
        open={menu !== null}
        onOpenChange={(next) => {
          if (!next) setMenu(null);
        }}
        anchor={menu?.anchor ?? null}
        returnFocusTo={menu?.returnTo ?? null}
        placement="bottom-start"
        aria-label={menu ? `Actions for ${menu.project.title}` : "Actions"}
      >
        {menu ? (
          <>
            <MenuItem icon={FolderOpen} onSelect={() => open(menu.project.id)}>
              Open
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={Heart} onSelect={() => void setFavorite([menu.project.id], !menu.project.favorite)}>
              {menu.project.favorite ? "Remove from Favorites" : "Add to Favorites"}
            </MenuItem>
            <MenuItem
              icon={PencilLine}
              onSelect={() => {
                const target = menu;
                const option = document.querySelector<HTMLElement>(`[role="option"][data-id="${CSS.escape(target.project.id)}"]`);
                setRenaming({ project: target.project, anchor: option });
              }}
            >
              Rename…
            </MenuItem>
            <MenuItem icon={Copy} onSelect={() => void duplicate(menu.project)}>
              Duplicate
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              icon={Trash2}
              destructive
              onSelect={() => void moveToTrash(selected.has(menu.project.id) && selected.size > 1 ? [...selected] : [menu.project.id])}
            >
              {selected.has(menu.project.id) && selected.size > 1 ? `Move ${selected.size} Projects to Trash` : "Move to Trash"}
            </MenuItem>
          </>
        ) : null}
      </Menu>
      {renaming && prefs.view === "grid" ? (
        <InlineRename
          project={renaming.project}
          anchor={renaming.anchor}
          onDone={(value) => {
            const target = renaming;
            setRenaming(null);
            if (value !== null) void rename(target.project, value);
            target.anchor?.focus({ preventScroll: true });
          }}
        />
      ) : null}
    </div>
  );
}

interface ProjectCardProps {
  project: Project;
  now: Date;
  onFavorite: (favorite: boolean) => void;
  onMore: (anchor: HTMLElement) => void;
}

function ProjectCard({ project, now, onFavorite, onMore }: ProjectCardProps) {
  const lab = getLab(project.labId);
  const thumbnail = useAssetUrl(project.thumbnailAssetId);
  const glyph = labIcon(lab);
  return (
    <MediaCard
      id={project.id}
      title={project.title}
      subtitle={projectSubtitle(project, lab?.title ?? project.labId, now)}
      thumbnail={thumbnail}
      ratio="16:10"
      placeholder={
        <span className="px-project-placeholder" style={cssVars({ "--_tint": lab ? `var(${lab.tint})` : "var(--px-system-gray)" })}>
          <Icon icon={glyph} size={28} />
        </span>
      }
      favorite={project.favorite}
      onFavoriteChange={onFavorite}
      onMore={onMore}
    />
  );
}

/** Finder-style rename: a field over the card's title (outside the listbox, so the grid stays a pure listbox). */
function InlineRename({ project, anchor, onDone }: { project: Project; anchor: HTMLElement | null; onDone: (value: string | null) => void }) {
  const [value, setValue] = useState(project.title);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const done = useRef(false);

  useLayoutEffect(() => {
    const place = () => {
      const text = anchor?.querySelector<HTMLElement>(".px-card__title") ?? anchor;
      setRect(text ? text.getBoundingClientRect() : null);
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor]);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    onDone(commit ? value : null);
  };

  if (!rect) return null;
  return createPortal(
    <input
      ref={input}
      className="px-inline-rename"
      aria-label={`Rename “${project.title}”`}
      value={value}
      maxLength={120}
      style={{ top: rect.top - 3, left: rect.left - 5, width: Math.max(160, rect.width + 10) }}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          finish(true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          finish(false);
        }
      }}
    />,
    document.body,
  );
}

interface ProjectsTableProps {
  projects: Project[];
  sort: ProjectSort;
  onSort: (sort: ProjectSort) => void;
  selected: ReadonlySet<string>;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onFavorite: (project: Project) => void;
  onMenu: (project: Project, anchor: HTMLElement) => void;
  renamingId: string | null;
  onRename: (project: Project, value: string) => void;
  onRenameCancel: () => void;
  now: Date;
}

function SortHeader({ label, value, sort, onSort }: { label: string; value: ProjectSort; sort: ProjectSort; onSort: (sort: ProjectSort) => void }) {
  const active = sort === value;
  return (
    <th scope="col" aria-sort={active ? (value === "name" ? "ascending" : "descending") : "none"}>
      <button type="button" className={cx("px-projects-table__sort", active && "px-projects-table__sort--active")} onClick={() => onSort(value)}>
        {label}
      </button>
    </th>
  );
}

function ProjectsTable({ projects, sort, onSort, selected, onSelect, onOpen, onFavorite, onMenu, renamingId, onRename, onRenameCancel, now }: ProjectsTableProps) {
  return (
    <table className="px-projects-table">
      <thead>
        <tr>
          <th scope="col" className="px-projects-table__fav">
            <span className="px-visually-hidden">Favorite</span>
          </th>
          <SortHeader label="Name" value="name" sort={sort} onSort={onSort} />
          <th scope="col">Lab</th>
          <SortHeader label="Date Edited" value="recent" sort={sort} onSort={onSort} />
          <SortHeader label="Date Created" value="created" sort={sort} onSort={onSort} />
          <th scope="col" className="px-projects-table__actions">
            <span className="px-visually-hidden">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {projects.map((project) => {
          const lab = getLab(project.labId);
          const isSelected = selected.has(project.id);
          return (
            <tr
              key={project.id}
              className={cx("px-projects-table__row", isSelected && "px-projects-table__row--selected")}
              aria-selected={isSelected}
              onClick={() => onSelect(project.id)}
              onDoubleClick={() => onOpen(project.id)}
            >
              <td className="px-projects-table__fav">
                <IconButton
                  icon={Heart}
                  label={project.favorite ? `Remove “${project.title}” from Favorites` : `Add “${project.title}” to Favorites`}
                  size="small"
                  pressed={project.favorite}
                  tooltip={false}
                  className={cx("px-projects-table__heart", project.favorite && "px-projects-table__heart--on")}
                  onClick={(event) => {
                    event.stopPropagation();
                    onFavorite(project);
                  }}
                />
              </td>
              <td className="px-projects-table__name">
                <ProjectThumb project={project} lab={lab} />
                {renamingId === project.id ? (
                  <RowRename project={project} onDone={(value) => (value === null ? onRenameCancel() : onRename(project, value))} />
                ) : (
                  <button
                    type="button"
                    className="px-projects-table__open"
                    onClick={(event) => {
                      event.stopPropagation();
                      onOpen(project.id);
                    }}
                  >
                    {project.title}
                  </button>
                )}
              </td>
              <td className="px-projects-table__secondary">{lab?.title ?? project.labId}</td>
              <td className="px-projects-table__secondary px-num">{relativeTime(editedAt(project), now)}</td>
              <td className="px-projects-table__secondary px-num">{relativeTime(project.createdAt, now)}</td>
              <td className="px-projects-table__actions">
                <IconButton
                  icon={Ellipsis}
                  label={`Actions for “${project.title}”`}
                  size="regular"
                  tooltip={false}
                  className="px-projects-table__more"
                  aria-haspopup="menu"
                  onClick={(event) => {
                    event.stopPropagation();
                    onMenu(project, event.currentTarget);
                  }}
                />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ProjectThumb({ project, lab }: { project: Project; lab: LabDefinition | null }) {
  const url = useAssetUrl(project.thumbnailAssetId);
  return (
    <span className="px-projects-table__thumb" aria-hidden="true" style={cssVars({ "--_tint": lab ? `var(${lab.tint})` : "var(--px-system-gray)" })}>
      {url ? <img src={url} alt="" loading="lazy" decoding="async" /> : <Icon icon={labIcon(lab)} size={12} />}
    </span>
  );
}

function RowRename({ project, onDone }: { project: Project; onDone: (value: string | null) => void }) {
  const [value, setValue] = useState(project.title);
  const done = useRef(false);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    onDone(commit ? value : null);
  };
  return (
    <input
      autoFocus
      className="px-inline-rename px-inline-rename--row"
      aria-label={`Rename “${project.title}”`}
      value={value}
      maxLength={120}
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setValue(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onBlur={() => finish(true)}
      onKeyDown={(event) => {
        if (event.key === "Enter") finish(true);
        else if (event.key === "Escape") finish(false);
      }}
    />
  );
}

function ProjectsSkeleton({ view }: { view: ProjectView }) {
  if (view === "list") {
    return (
      <div className="px-projects-skeleton-list" aria-busy="true" aria-label="Loading projects">
        {Array.from({ length: 8 }, (_, index) => (
          <Skeleton key={index} height={14} width={`${60 + ((index * 13) % 30)}%`} />
        ))}
      </div>
    );
  }
  return (
    <div className="px-grid px-projects-skeleton" style={cssVars({ "--px-tile-min": "220px" })} aria-busy="true" aria-label="Loading projects">
      {Array.from({ length: 8 }, (_, index) => (
        <div key={index} className="px-projects-skeleton__card">
          <Skeleton height="auto" radius={10} className="px-projects-skeleton__thumb" />
          <Skeleton height={11} width="70%" />
          <Skeleton height={9} width="45%" />
        </div>
      ))}
    </div>
  );
}

interface ProjectsEmptyProps {
  total: number;
  search: string;
  favoritesOnly: boolean;
  lab: LabDefinition | null;
  newProjectMenu: ReactNode;
  hasCreatable: boolean;
}

function ProjectsEmpty({ total, search, favoritesOnly, lab, newProjectMenu, hasCreatable }: ProjectsEmptyProps) {
  if (search.trim() !== "") {
    return <EmptyState icon={Search} title={`No Results for “${search.trim()}”`} description="Check the spelling or try a new search." />;
  }
  if (favoritesOnly) {
    return <EmptyState icon={Heart} title="No Favorites" description="Click ♥ on a project, or select it and press . (period), to add it to Favorites." />;
  }
  if (lab && total > 0) {
    return (
      <EmptyState
        icon={labIcon(lab)}
        title={`No ${lab.title} Projects`}
        description={lab.description}
        action={
          lab.capabilities.projects ? (
            <Button size="large" variant="borderedProminent" icon={Plus} onClick={() => navigate({ name: "lab", labId: lab.id })}>
              New {lab.title} Project
            </Button>
          ) : null
        }
      />
    );
  }
  return (
    <EmptyState
      icon={FolderClosed}
      title="No Projects Yet"
      description="Start a project in any lab. Changes save automatically and versions build up as you work."
      action={
        hasCreatable ? (
          <MenuButton size="large" variant="borderedProminent" icon={Plus} menu={newProjectMenu}>
            New Project
          </MenuButton>
        ) : null
      }
    />
  );
}
