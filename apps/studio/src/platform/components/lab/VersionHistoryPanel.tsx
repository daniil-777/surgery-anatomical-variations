// Version History (APPLE_STYLE_SPEC §3.6.3): a solid panel floating over the lab (never glass over WebGL, §0.2) with the
// current version on top, named versions pinned under it and the rest by day, runs of autosaves folded. Restore and Open
// as Copy go through the editor (they move the session); naming and deleting happen here.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Bookmark,
  BookmarkCheck,
  BookmarkMinus,
  ChevronRight,
  CopyPlus,
  History,
  PencilLine,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { useBackend } from "../../app/context";
import { useQuery } from "../../app/query";
import type { ProjectVersion } from "../../core/types";
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Icon,
  IconButton,
  MenuItem,
  MenuSeparator,
  SegmentedControl,
  Skeleton,
  cx,
  useToast,
} from "../../ui";
import { friendlyError } from "./friendlyError";
import { useAssetUrl } from "./hooks";
import { NameSheet } from "./NameSheet";
import { IconMenuButton } from "./ProjectBar";
import {
  buildVersionHistory,
  canDeleteVersion,
  daysUntilExpiry,
  formatVersionTime,
  isNamedVersion,
  nextVersionName,
  retentionNote,
  versionKindLabel,
  versionTitle,
  type VersionRow,
} from "./versionHistory";

export interface VersionHistoryPanelProps {
  projectId: string;
  headVersionId: string | null;
  headSeq: number;
  /** The project has changes since the current version (a draft or unsaved edits). */
  editedSinceHead: boolean;
  /** Trashed or open in another tab: browsing only. */
  readOnly: boolean;
  /** The lab's busy reason: restoring waits for false. */
  busy: false | string;
  retentionDays: number | null;
  onClose: () => void;
  onRestore: (version: ProjectVersion) => void;
  onOpenCopy: (version: ProjectVersion) => void;
}

type Naming = { version: ProjectVersion; mode: "name" | "rename" };

export function versionsKey(projectId: string): string {
  return `projects:versions:${projectId}`;
}

export function VersionHistoryPanel({
  projectId,
  headVersionId,
  headSeq,
  editedSinceHead,
  readOnly,
  busy,
  retentionDays,
  onClose,
  onRestore,
  onOpenCopy,
}: VersionHistoryPanelProps) {
  const backend = useBackend();
  const toast = useToast();
  const { data, error, loading, refresh } = useQuery(versionsKey(projectId), () => backend.projects.versions(projectId));
  const [filter, setFilter] = useState<"all" | "named">("all");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [naming, setNaming] = useState<Naming | null>(null);
  const [deleting, setDeleting] = useState<ProjectVersion | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  // a commit, restore or name elsewhere moves the head: reload the list
  useEffect(() => {
    void refresh();
  }, [headVersionId, headSeq, refresh]);

  const now = new Date();
  const model = useMemo(
    () => buildVersionHistory(data ?? [], { now, headVersionId, filter }),
    // `now` only moves day labels; recomputing per render of new data is enough
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, headVersionId, filter],
  );

  // rank among unnamed, non-current versions (newest first) for the retention hint
  const ranks = useMemo(() => {
    const map = new Map<string, number>();
    [...(data ?? [])]
      .filter((version) => !isNamedVersion(version) && version.id !== headVersionId)
      .sort((a, b) => b.seq - a.seq)
      .forEach((version, index) => map.set(version.id, index));
    return map;
  }, [data, headVersionId]);

  const label = async (version: ProjectVersion, name: string | null) => {
    await backend.projects.label(version.id, name);
    await refresh();
  };

  const removeName = async (version: ProjectVersion) => {
    const previous = version.label;
    try {
      await label(version, null);
      toast.show({
        message: `Removed the name “${previous ?? ""}”.`,
        tone: "info",
        action: previous
          ? {
              label: "Undo",
              onAction: () => {
                void label(version, previous).catch((reason: unknown) => toast.show({ message: friendlyError(reason), tone: "error" }));
              },
            }
          : undefined,
      });
    } catch (reason) {
      toast.show({ message: friendlyError(reason, "Couldn't remove the name."), tone: "error" });
    }
  };

  const confirmDelete = async () => {
    const version = deleting;
    if (!version) return;
    setDeleteBusy(true);
    try {
      await backend.projects.deleteVersion(version.id);
      await refresh();
      toast.show({ message: `Deleted “${versionTitle(version)}”.`, tone: "info" });
      setDeleting(null);
    } catch (reason) {
      toast.show({ message: friendlyError(reason, "Couldn't delete the version."), tone: "error" });
    } finally {
      setDeleteBusy(false);
    }
  };

  const restoreBlocked = readOnly ? "read-only" : busy ? busy : null;

  const menuFor = (version: ProjectVersion) => {
    const isHead = version.id === headVersionId;
    const named = isNamedVersion(version);
    return (
      <>
        <MenuItem icon={RotateCcw} disabled={isHead || restoreBlocked !== null} onSelect={() => onRestore(version)}>
          {isHead ? "Current Version" : "Restore This Version…"}
        </MenuItem>
        <MenuItem icon={CopyPlus} onSelect={() => onOpenCopy(version)}>
          Open as Copy
        </MenuItem>
        <MenuSeparator />
        {named ? (
          <>
            <MenuItem icon={PencilLine} disabled={readOnly} onSelect={() => setNaming({ version, mode: "rename" })}>
              Rename…
            </MenuItem>
            <MenuItem icon={BookmarkMinus} disabled={readOnly} onSelect={() => void removeName(version)}>
              Remove Name
            </MenuItem>
          </>
        ) : (
          <MenuItem icon={Bookmark} disabled={readOnly} onSelect={() => setNaming({ version, mode: "name" })}>
            Name This Version…
          </MenuItem>
        )}
        {canDeleteVersion(version, headVersionId) ? (
          <>
            <MenuSeparator />
            <MenuItem icon={Trash2} destructive disabled={readOnly} onSelect={() => setDeleting(version)}>
              Delete Version…
            </MenuItem>
          </>
        ) : null}
      </>
    );
  };

  const renderVersion = (version: ProjectVersion, compact = false) => {
    const isHead = version.id === headVersionId;
    const rank = ranks.get(version.id);
    const expiry = rank === undefined || retentionDays === null ? null : daysUntilExpiry(version.createdAt, retentionDays, rank, now);
    return (
      <VersionRowView
        key={version.id}
        version={version}
        current={isHead}
        compact={compact}
        editedSince={isHead && editedSinceHead}
        expiryDays={expiry !== null && expiry <= 7 ? expiry : null}
        menu={menuFor(version)}
      />
    );
  };

  const renderRow = (row: VersionRow) => {
    if (row.type === "version") return renderVersion(row.version);
    const open = expanded.has(row.key);
    const newest = row.versions[0];
    const oldest = row.versions[row.versions.length - 1];
    return (
      <li key={row.key} className="px-vh-fold">
        <button
          type="button"
          className="px-vh-fold__toggle"
          aria-expanded={open}
          onClick={() =>
            setExpanded((current) => {
              const next = new Set(current);
              if (next.has(row.key)) next.delete(row.key);
              else next.add(row.key);
              return next;
            })
          }
        >
          <Icon icon={ChevronRight} size={10} className={cx("px-vh-fold__chevron", open && "px-vh-fold__chevron--open")} />
          <span>{row.versions.length} Autosaves</span>
          {newest && oldest ? (
            <span className="px-vh-fold__range px-num">
              {formatVersionTime(oldest.createdAt)} – {formatVersionTime(newest.createdAt)}
            </span>
          ) : null}
        </button>
        {open ? <ul className="px-vh-list px-vh-list--nested">{row.versions.map((version) => renderVersion(version, true))}</ul> : null}
      </li>
    );
  };

  const empty = !loading && !error && model.total === 0;

  return (
    <section className="px-vh" aria-label="Version History">
      <div className="px-vh__header">
        <h2 className="px-vh__title">Version History</h2>
        <IconButton icon={X} label="Close Version History" shortcut="alt+mod+y" onClick={onClose} />
      </div>
      <div className="px-vh__filter">
        <SegmentedControl<"all" | "named">
          aria-label="Show"
          fullWidth
          value={filter}
          onChange={setFilter}
          items={[
            { value: "all", label: "All" },
            { value: "named", label: "Named" },
          ]}
        />
      </div>
      <div className="px-vh__scroll">
        {error && !data ? (
          <EmptyState
            icon={History}
            title="Couldn't Load Versions"
            description={friendlyError(error, "Check your connection and try again.")}
            headingLevel={3}
            action={
              <Button onClick={() => void refresh()} size="large">
                Try Again
              </Button>
            }
          />
        ) : loading && !data ? (
          <ul className="px-vh-list" aria-label="Loading versions" aria-busy="true">
            {Array.from({ length: 6 }, (_, index) => (
              <li key={index} className="px-vh-row px-vh-row--skeleton">
                <Skeleton className="px-vh-row__thumb" width={56} height={42} radius={6} />
                <div className="px-vh-row__text">
                  <Skeleton width="60%" height={11} />
                  <Skeleton width="40%" height={9} />
                </div>
              </li>
            ))}
          </ul>
        ) : empty ? (
          <EmptyState icon={History} title="No Versions Yet" description="Versions are saved as you work. Press ⇧⌘S to save a named version." headingLevel={3} />
        ) : (
          <>
            {model.current ? (
              <div className="px-vh-section">
                <h3 className="px-vh-section__title">Current</h3>
                <ul className="px-vh-list">{renderVersion(model.current)}</ul>
              </div>
            ) : null}
            {model.named.length > 0 ? (
              <div className="px-vh-section">
                <h3 className="px-vh-section__title">Named Versions</h3>
                <ul className="px-vh-list">{model.named.map((version) => renderVersion(version))}</ul>
              </div>
            ) : filter === "named" ? (
              <p className="px-vh__hint">No named versions yet. Name a version to keep it until you remove its name.</p>
            ) : null}
            {model.days.map((group) => (
              <div key={group.key} className="px-vh-section">
                <h3 className="px-vh-section__title">{group.label}</h3>
                <ul className="px-vh-list">{group.rows.map(renderRow)}</ul>
              </div>
            ))}
          </>
        )}
      </div>
      <p className="px-vh__footer">{retentionNote(retentionDays)}</p>

      <NameSheet
        open={naming !== null}
        onClose={() => setNaming(null)}
        title={naming?.mode === "rename" ? "Rename Version" : "Name This Version"}
        description={naming?.mode === "rename" ? undefined : "Named versions are kept until you remove their name."}
        initialValue={naming ? (naming.mode === "rename" ? versionTitle(naming.version) : nextVersionName(naming.version.seq - 1)) : ""}
        submitLabel={naming?.mode === "rename" ? "Rename" : "Name Version"}
        failure="Couldn't name the version."
        onSubmit={async (name) => {
          if (naming) await label(naming.version, name);
        }}
      />
      <Alert
        open={deleting !== null}
        onClose={() => {
          if (!deleteBusy) setDeleting(null);
        }}
        title={`Delete “${deleting ? versionTitle(deleting) : ""}”?`}
        message="This version will be removed from the history. You can't undo this action."
        actionLabel={deleteBusy ? "Deleting…" : "Delete"}
        destructive
        onAction={() => void confirmDelete()}
      />
    </section>
  );
}

interface VersionRowViewProps {
  version: ProjectVersion;
  current: boolean;
  compact: boolean;
  editedSince: boolean;
  expiryDays: number | null;
  menu: ReactNode;
}

function VersionRowView({ version, current, compact, editedSince, expiryDays, menu }: VersionRowViewProps) {
  const thumbnail = useAssetUrl(compact ? null : version.thumbnailAssetId);
  const named = isNamedVersion(version);
  const title = versionTitle(version);
  return (
    <li className={cx("px-vh-row", compact && "px-vh-row--compact", current && "px-vh-row--current")}>
      {compact ? null : (
        <span className="px-vh-row__thumb" aria-hidden="true">
          {thumbnail ? <img src={thumbnail} alt="" loading="lazy" decoding="async" draggable={false} /> : <Icon icon={History} size={16} />}
        </span>
      )}
      <span className="px-vh-row__text">
        <span className="px-vh-row__title">
          {current ? <span className="px-vh-row__dot" aria-hidden="true" /> : null}
          <span className="px-vh-row__name">{compact ? formatVersionTime(version.createdAt) : title}</span>
          {named ? <Icon icon={BookmarkCheck} size={12} className="px-vh-row__bookmark" /> : null}
        </span>
        <span className="px-vh-row__meta">
          {compact ? (
            versionKindLabel(version.kind)
          ) : (
            <>
              {versionKindLabel(version.kind)} · <span className="px-num">{formatVersionTime(version.createdAt)}</span>
            </>
          )}
        </span>
        {editedSince ? <span className="px-vh-row__note">Edited since this version</span> : null}
        {expiryDays !== null ? (
          <span className="px-vh-row__expiry">{expiryDays === 0 ? "May be removed soon" : `May be removed in ${expiryDays} ${expiryDays === 1 ? "day" : "days"}`}</span>
        ) : null}
      </span>
      {current ? (
        <Badge tone="accent" className="px-vh-row__badge">
          Current
        </Badge>
      ) : null}
      <IconMenuButton label={`Actions for ${compact ? `${versionKindLabel(version.kind)} at ${formatVersionTime(version.createdAt)}` : title}`} menu={menu} size="regular" className="px-vh-row__more" />
    </li>
  );
}
