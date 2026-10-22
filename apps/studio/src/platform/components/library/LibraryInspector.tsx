// The Library's inspector column (APPLE_STYLE_SPEC §2.10, §3.4). One item: preview, name, description and tags (saved
// as they change), facts, the project and version it came from, its claims shown exactly as the lab wrote them, a
// summary of its metadata and its files. Several items: shared facts and batch actions. An upload in progress: its
// progress and a way to cancel it.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Download, Eye, Heart, RotateCcw, Trash2, X } from "lucide-react";
import { useBackend, useSession } from "../../app/context";
import { navigate } from "../../app/router";
import { labIcon } from "../../app/shell/labIcons";
import { useAssetUrl, useFreshQuery } from "../../app/shell/queries";
import { formatDateTime } from "../../app/shell/time";
import { getLab } from "../../core/labs/registry";
import type { LibraryItem, LibraryKind, Uuid } from "../../core/types";
import {
  Badge,
  Button,
  formatBytes,
  formatCount,
  formatDuration,
  Icon,
  IconButton,
  Inspector,
  InspectorPlaceholder,
  InspectorRow,
  InspectorSection,
  ProgressBar,
  Skeleton,
  TextArea,
  TextField,
} from "../../ui";
import { FileList, type FileListEntry } from "../media/FileList";
import type { Size } from "../media/zoom";
import { ItemPreview } from "./ItemPreview";
import { KIND_INFO, LIBRARY_KIND_ORDER } from "./kinds";
import { libraryErrorMessage, titleProblem } from "./messages";
import { isUpload, metadataRowCount, metadataSummary, readClaims, readMediaFacts, ROLE_LABEL, type MediaFacts } from "./metadata";
import { TagsEditor, type TagsEditorHandle } from "./TagsEditor";
import { fileKey, LIBRARY_KEY_PREFIX, useLibraryItem, type LibraryActions, type LibraryDownloads } from "./useLibrary";
import type { UploadEntry } from "./uploadStore";
import "./library.css";

export interface FocusRequest {
  field: "title" | "tags";
  /** Changes on every request, so asking twice focuses twice. */
  nonce: number;
}

const number = new Intl.NumberFormat("en-US");

function KindLabel({ kind }: { kind: LibraryKind }) {
  return (
    <span className="px-lib-inline">
      <Icon icon={KIND_INFO[kind].icon} size={13} />
      <span>{KIND_INFO[kind].singular}</span>
    </span>
  );
}

function OriginLabel({ item }: { item: LibraryItem }) {
  const lab = item.labId ? getLab(item.labId) : null;
  if (lab) {
    return (
      <span className="px-lib-inline">
        <Icon icon={labIcon(lab.icon)} size={13} style={{ color: `var(${lab.tint})` }} />
        <span>{lab.title}</span>
      </span>
    );
  }
  if (item.labId) return <span>{item.labId}</span>;
  return <span>{isUpload(item.metadata) ? "Uploaded File" : "—"}</span>;
}

function FactRows({ facts }: { facts: MediaFacts }) {
  return (
    <>
      {facts.width && facts.height ? (
        <InspectorRow label="Dimensions">
          <span className="px-num">
            {number.format(facts.width)} × {number.format(facts.height)}
          </span>
        </InspectorRow>
      ) : null}
      {facts.durationMs ? (
        <InspectorRow label="Duration">
          <span className="px-num">{formatDuration(facts.durationMs / 1000)}</span>
        </InspectorRow>
      ) : null}
      {facts.requestedFps ? (
        <InspectorRow label="Capture Rate">
          <span className="px-num">{number.format(facts.requestedFps)} fps requested</span>
        </InspectorRow>
      ) : null}
      {facts.meshes !== undefined ? (
        <InspectorRow label="Meshes">
          <span className="px-num">{number.format(facts.meshes)}</span>
        </InspectorRow>
      ) : null}
      {facts.vertices !== undefined ? (
        <InspectorRow label="Vertices">
          <span className="px-num">{number.format(facts.vertices)}</span>
        </InspectorRow>
      ) : null}
      {facts.triangles !== undefined ? (
        <InspectorRow label="Triangles">
          <span className="px-num">{number.format(facts.triangles)}</span>
        </InspectorRow>
      ) : null}
      {facts.generator ? <InspectorRow label="Made With">{facts.generator}</InspectorRow> : null}
    </>
  );
}

function SourceSection({ projectId, versionId }: { projectId: Uuid; versionId: Uuid | null }) {
  const backend = useBackend();
  const userId = useSession()?.user.id ?? null;
  const project = useFreshQuery(userId ? `${LIBRARY_KEY_PREFIX}source-project:${userId}:${projectId}` : null, () => backend.projects.get(projectId));
  const versions = useFreshQuery(userId && versionId ? `${LIBRARY_KEY_PREFIX}source-versions:${userId}:${projectId}` : null, () =>
    backend.projects.versions(projectId),
  );
  const version = versionId ? versions.data?.find((candidate) => candidate.id === versionId) : undefined;
  const title = project.data?.title;
  return (
    <InspectorSection title="Source" persistKey="library-source">
      <InspectorRow label="Project">
        {project.error ? (
          <span className="px-secondary">No longer available</span>
        ) : title ? (
          <a
            href={`#/projects/${projectId}`}
            className="px-lib-link"
            onClick={(event) => {
              event.preventDefault();
              navigate({ name: "project", id: projectId });
            }}
          >
            {title}
            {project.data?.trashedAt ? " (in the Trash)" : ""}
          </a>
        ) : (
          <Skeleton width="60%" />
        )}
      </InspectorRow>
      {versionId ? (
        <InspectorRow label="Version">
          {version ? (
            <span>
              <span className="px-num">Version {version.seq}</span>
              {version.label ? ` · ${version.label}` : ""}
            </span>
          ) : versions.loading ? (
            <Skeleton width="40%" />
          ) : (
            <span className="px-secondary">No longer kept</span>
          )}
        </InspectorRow>
      ) : null}
    </InspectorSection>
  );
}

export interface LibraryItemInspectorProps {
  item: LibraryItem;
  actions: LibraryActions;
  downloads: LibraryDownloads;
  focusRequest: FocusRequest | null;
  onQuickLook: () => void;
  /** A close button in the header (the floating inspector of narrow windows). */
  onClose?: (() => void) | undefined;
}

export function LibraryItemInspector({ item: listed, actions, downloads, focusRequest, onQuickLook, onClose }: LibraryItemInspectorProps) {
  const full = useLibraryItem(listed.id);
  const item = full.data && full.data.id === listed.id ? { ...full.data, favorite: listed.favorite, title: listed.title, tags: listed.tags, description: listed.description } : listed;
  const [title, setTitle] = useState(item.title);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [description, setDescription] = useState(item.description);
  const [measured, setMeasured] = useState<MediaFacts>({});
  const reverting = useRef(false);
  const titleInput = useRef<HTMLInputElement | null>(null);
  const tagsEditor = useRef<TagsEditorHandle | null>(null);

  useEffect(() => {
    setTitle(item.title);
    setTitleError(null);
  }, [item.id, item.title]);
  useEffect(() => setDescription(item.description), [item.id, item.description]);
  useEffect(() => setMeasured({}), [item.id]);

  useEffect(() => {
    if (!focusRequest) return;
    if (focusRequest.field === "title") {
      titleInput.current?.focus();
      titleInput.current?.select();
    } else {
      tagsEditor.current?.focus();
    }
    // a new nonce is a new request
  }, [focusRequest?.nonce, focusRequest?.field]);

  const commitTitle = async () => {
    if (reverting.current) {
      reverting.current = false;
      return;
    }
    const next = title.trim();
    if (next === item.title) {
      setTitle(item.title);
      setTitleError(null);
      return;
    }
    const problem = titleProblem(next);
    setTitleError(problem);
    if (problem) return;
    if (!(await actions.update(item, { title: next }))) setTitle(item.title);
  };

  const commitDescription = async () => {
    if (reverting.current) {
      reverting.current = false;
      return;
    }
    if (description === item.description) return;
    if (!(await actions.update(item, { description }))) setDescription(item.description);
  };

  const revertOnEscape = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>, reset: () => void) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    reset();
    reverting.current = true;
    event.currentTarget.blur();
  };

  const facts = useMemo<MediaFacts>(() => ({ ...measured, ...readMediaFacts(item.metadata) }), [measured, item.metadata]);
  const claims = readClaims(item.metadata);
  const summary = metadataSummary(item.metadata);
  const hiddenRows = metadataRowCount(item.metadata) - summary.length;
  const files = item.files;
  const fileEntries: FileListEntry[] = (files ?? []).map((file) => ({
    key: fileKey(file),
    filename: file.filename,
    roleLabel: ROLE_LABEL[file.role] ?? file.role,
    byteSize: file.byteSize,
    mimeType: file.mimeType,
  }));
  const zipping = downloads.zipProgress !== null;
  const many = (files?.length ?? 0) > 1;

  return (
    <Inspector
      aria-label="Inspector"
      title={item.title}
      headerAccessory={
        <span className="px-lib-inspector__accessories">
          <IconButton
            icon={Heart}
            label={item.favorite ? "Remove from Favorites" : "Add to Favorites"}
            pressed={item.favorite}
            onClick={() => void actions.setFavorite([item], !item.favorite)}
            className="px-lib-favorite"
          />
          {onClose ? <IconButton icon={X} label="Close Inspector" onClick={onClose} /> : null}
        </span>
      }
      preview={
        <ItemPreview
          key={item.id}
          item={item}
          variant="inspector"
          onModelStats={(stats) => setMeasured((current) => ({ ...current, ...stats }))}
          onImageSize={(size: Size) => setMeasured((current) => ({ ...current, width: size.width, height: size.height }))}
          onVideoInfo={(info) =>
            setMeasured((current) => {
              const next: MediaFacts = { ...current, width: info.width, height: info.height };
              if (info.durationMs !== null) next.durationMs = info.durationMs;
              return next;
            })
          }
        />
      }
      footer={
        <>
          <Button
            variant="borderedProminent"
            icon={Download}
            loading={zipping}
            loadingLabel={`Preparing… ${Math.round((downloads.zipProgress ?? 0) * 100)}%`}
            onClick={() => void downloads.downloadItems([item])}
          >
            {many ? "Download All" : "Download"}
          </Button>
          <IconButton icon={Eye} label="Quick Look" shortcut="space" variant="bordered" onClick={onQuickLook} />
          <IconButton icon={Trash2} label="Move to Trash" variant="bordered" className="px-lib-trash" onClick={() => void actions.moveToTrash([item])} />
        </>
      }
    >
      <div className="px-lib-inspector__edit">
        <TextField
          ref={titleInput}
          label="Name"
          size="regular"
          value={title}
          error={titleError ?? undefined}
          maxLength={200}
          onChange={(event) => {
            setTitle(event.target.value);
            if (titleError) setTitleError(null);
          }}
          onBlur={() => void commitTitle()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
              return;
            }
            revertOnEscape(event, () => {
              setTitle(item.title);
              setTitleError(null);
            });
          }}
        />
        <TextArea
          label="Description"
          rows={2}
          value={description}
          maxLength={2000}
          placeholder="Add a Description"
          onChange={(event) => setDescription(event.target.value)}
          onBlur={() => void commitDescription()}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              event.currentTarget.blur();
              return;
            }
            revertOnEscape(event, () => setDescription(item.description));
          }}
        />
        <TagsEditor ref={tagsEditor} tags={item.tags} onChange={(tags) => void actions.update(item, { tags })} />
      </div>

      <InspectorSection title="Information" persistKey="library-information">
        <InspectorRow label="Kind">
          <KindLabel kind={item.kind} />
        </InspectorRow>
        <InspectorRow label="Source">
          <OriginLabel item={item} />
        </InspectorRow>
        <InspectorRow label="Added">{formatDateTime(item.createdAt)}</InspectorRow>
        {item.updatedAt !== item.createdAt ? <InspectorRow label="Modified">{formatDateTime(item.updatedAt)}</InspectorRow> : null}
        <InspectorRow label="Size">
          <span className="px-num">{formatBytes(item.byteSize)}</span>
        </InspectorRow>
        <FactRows facts={facts} />
      </InspectorSection>

      {item.sourceProjectId ? <SourceSection projectId={item.sourceProjectId} versionId={item.sourceVersionId} /> : null}

      {claims ? (
        <InspectorSection title="Provenance" persistKey="library-provenance">
          {claims.evidence ? (
            <InspectorRow label="Evidence">
              <span className="px-lib-verbatim">{claims.evidence}</span>
            </InspectorRow>
          ) : null}
          {claims.limitations.length > 0 ? (
            <InspectorRow label="Limitations">
              {claims.limitations.map((limitation, index) => (
                <span key={`${index}-${limitation}`} className="px-lib-verbatim px-lib-verbatim--item">
                  {limitation}
                </span>
              ))}
            </InspectorRow>
          ) : null}
          {claims.rights ? (
            <InspectorRow label="Rights">
              <span className="px-lib-verbatim">{claims.rights}</span>
            </InspectorRow>
          ) : null}
        </InspectorSection>
      ) : null}

      <InspectorSection title="Files" persistKey="library-files">
        {files ? (
          fileEntries.length > 0 ? (
            <FileList
              files={fileEntries}
              busy={downloads.busyFiles}
              aria-label={`Files of ${item.title}`}
              onDownload={(entry) => {
                const file = files.find((candidate) => fileKey(candidate) === entry.key);
                if (file) void downloads.downloadFile(file);
              }}
            />
          ) : (
            <p className="px-lib-note">No files.</p>
          )
        ) : full.error ? (
          <p className="px-lib-note">{libraryErrorMessage(full.error, "load")}</p>
        ) : (
          <div className="px-lib-skeleton-rows" aria-hidden="true">
            <Skeleton width="80%" />
            <Skeleton width="55%" />
          </div>
        )}
      </InspectorSection>

      {summary.length > 0 ? (
        <InspectorSection title="Metadata" defaultOpen={false} persistKey="library-metadata">
          {summary.map((row) => (
            <InspectorRow key={row.key} label={<span title={row.key}>{row.key}</span>}>
              <span className="px-lib-verbatim">{row.value}</span>
            </InspectorRow>
          ))}
          {hiddenRows > 0 ? <p className="px-lib-note">{formatCount(hiddenRows, "more field")}. Download the item to see everything.</p> : null}
        </InspectorSection>
      ) : null}
    </Inspector>
  );
}

function kindSummary(items: readonly LibraryItem[]): string {
  const counts = new Map<LibraryKind, number>();
  for (const item of items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  return LIBRARY_KIND_ORDER.filter((kind) => counts.has(kind))
    .map((kind) => {
      const count = counts.get(kind) ?? 0;
      return `${number.format(count)} ${count === 1 ? KIND_INFO[kind].singular : KIND_INFO[kind].plural}`;
    })
    .join(", ");
}

function StackThumb({ item }: { item: LibraryItem }) {
  const url = useAssetUrl(item.thumbnailAssetId);
  return (
    <span className="px-lib-stack__thumb">
      {url ? <img src={url} alt="" draggable={false} /> : <Icon icon={KIND_INFO[item.kind].icon} size={22} />}
    </span>
  );
}

export interface LibrarySelectionInspectorProps {
  items: readonly LibraryItem[];
  actions: LibraryActions;
  downloads: LibraryDownloads;
  onClose?: (() => void) | undefined;
}

/** Several items: what they are, how much space they take, and what can be done to all of them at once. */
export function LibrarySelectionInspector({ items, actions, downloads, onClose }: LibrarySelectionInspectorProps) {
  const allFavorite = items.every((item) => item.favorite);
  const size = items.reduce((sum, item) => sum + item.byteSize, 0);
  const zipping = downloads.zipProgress !== null;
  return (
    <Inspector
      aria-label="Inspector"
      title={formatCount(items.length, "Item")}
      headerAccessory={onClose ? <IconButton icon={X} label="Close Inspector" onClick={onClose} /> : null}
      preview={
        <div className="px-lib-stack" aria-hidden="true">
          {items.slice(0, 4).map((item) => (
            <StackThumb key={item.id} item={item} />
          ))}
        </div>
      }
      footer={
        <>
          <Button
            variant="borderedProminent"
            icon={Download}
            loading={zipping}
            loadingLabel={`Preparing… ${Math.round((downloads.zipProgress ?? 0) * 100)}%`}
            onClick={() => void downloads.downloadItems(items)}
          >
            Download as ZIP
          </Button>
          <IconButton icon={Trash2} label={`Move ${items.length} Items to Trash`} variant="bordered" className="px-lib-trash" onClick={() => void actions.moveToTrash(items)} />
        </>
      }
    >
      <InspectorSection title="Selection" persistKey="library-selection">
        <InspectorRow label="Items">{kindSummary(items)}</InspectorRow>
        <InspectorRow label="Combined Size">
          <span className="px-num">{formatBytes(size)}</span>
        </InspectorRow>
      </InspectorSection>
      <div className="px-lib-inspector__actions">
        <Button icon={Heart} onClick={() => void actions.setFavorite(items, !allFavorite)}>
          {allFavorite ? "Remove from Favorites" : "Add to Favorites"}
        </Button>
      </div>
    </Inspector>
  );
}

const STATUS_TEXT: Record<UploadEntry["status"], string> = {
  queued: "Waiting to upload",
  preparing: "Preparing",
  uploading: "Uploading",
  finishing: "Finishing",
  failed: "Not uploaded",
};

export interface UploadInspectorProps {
  entry: UploadEntry;
  maxFileBytes?: number | undefined;
  onCancel: () => void;
  onRetry: () => void;
  onClose?: (() => void) | undefined;
}

/** An upload that is still on its way (or that failed): progress, what went wrong, and Cancel / Try Again. */
export function UploadInspector({ entry, maxFileBytes, onCancel, onRetry, onClose }: UploadInspectorProps) {
  const failed = entry.status === "failed";
  return (
    <Inspector
      aria-label="Inspector"
      title={entry.name}
      headerAccessory={onClose ? <IconButton icon={X} label="Close Inspector" onClick={onClose} /> : null}
      preview={
        entry.previewUrl ? (
          <img src={entry.previewUrl} alt="" className="px-lib-upload-preview" draggable={false} />
        ) : (
          <div className="px-item-preview px-item-preview--empty">
            <Icon icon={KIND_INFO[entry.plan.kind].icon} size={40} />
          </div>
        )
      }
      footer={
        failed ? (
          <>
            <Button variant="borderedProminent" icon={RotateCcw} onClick={onRetry}>
              Try Again
            </Button>
            <Button onClick={onCancel}>Remove</Button>
          </>
        ) : (
          <Button onClick={onCancel}>Cancel Upload</Button>
        )
      }
    >
      <InspectorSection title="Upload" persistKey="library-upload">
        <InspectorRow label="Kind">
          <KindLabel kind={entry.plan.kind} />
        </InspectorRow>
        <InspectorRow label="Format">{entry.plan.format}</InspectorRow>
        <InspectorRow label="Size">
          <span className="px-num">{formatBytes(entry.size)}</span>
        </InspectorRow>
        <InspectorRow label="Status">
          {failed ? <Badge tone="danger">{STATUS_TEXT.failed}</Badge> : STATUS_TEXT[entry.status]}
        </InspectorRow>
        {failed ? (
          <p className="px-lib-note px-lib-note--danger" role="alert">
            {libraryErrorMessage(entry.error, "upload", { name: entry.name, maxFileBytes })}
          </p>
        ) : (
          <ProgressBar value={entry.status === "queued" ? null : entry.progress} showValue aria-label={`Uploading “${entry.name}”`} />
        )}
      </InspectorSection>
    </Inspector>
  );
}

/** Nothing selected. */
export function EmptyInspector() {
  return (
    <Inspector aria-label="Inspector">
      <InspectorPlaceholder>No Selection</InspectorPlaceholder>
    </Inspector>
  );
}
