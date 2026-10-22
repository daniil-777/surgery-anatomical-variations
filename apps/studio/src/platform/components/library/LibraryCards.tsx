// Tiles of the Library grid (APPLE_STYLE_SPEC §2.9): a library item with its thumbnail (a signed URL through the shared
// asset-URL cache), a kind badge where kinds are mixed, the duration of recordings and the favourite heart; and an
// upload on its way, with its progress ring until it becomes an item.
import { CircleAlert } from "lucide-react";
import { useAssetUrl } from "../../app/shell/queries";
import { getLab } from "../../core/labs/registry";
import type { LibraryItem } from "../../core/types";
import { Badge, formatDuration, formatPercent, Icon, MediaCard } from "../../ui";
import { KIND_INFO, type LibraryScope } from "./kinds";
import { isUpload, readMediaFacts } from "./metadata";
import type { UploadEntry } from "./uploadStore";
import "./library.css";

function Placeholder({ kind }: { kind: LibraryItem["kind"] }) {
  return (
    <span className="px-lib-card-placeholder">
      <Icon icon={KIND_INFO[kind].icon} size={28} />
    </span>
  );
}

/** "Shape · Organ Design", "Image · Uploaded". */
export function itemSubtitle(item: Pick<LibraryItem, "kind" | "labId" | "metadata">): string {
  const lab = item.labId ? getLab(item.labId)?.title ?? item.labId : isUpload(item.metadata) ? "Uploaded" : null;
  return lab ? `${KIND_INFO[item.kind].singular} · ${lab}` : KIND_INFO[item.kind].singular;
}

export interface ItemCardProps {
  item: LibraryItem;
  scope: LibraryScope;
  onFavoriteChange: (favorite: boolean) => void;
  onMore: (anchor: HTMLElement) => void;
}

export function ItemCard({ item, scope, onFavoriteChange, onMore }: ItemCardProps) {
  const thumbnail = useAssetUrl(item.thumbnailAssetId);
  const facts = readMediaFacts(item.metadata);
  const mixed = scope === "all" || scope === "favorites";
  const kind = KIND_INFO[item.kind];
  return (
    <MediaCard
      id={item.id}
      title={item.title}
      subtitle={itemSubtitle(item)}
      thumbnail={item.thumbnailAssetId ? thumbnail : null}
      placeholder={<Placeholder kind={item.kind} />}
      duration={item.kind === "recording" && facts.durationMs ? formatDuration(facts.durationMs / 1000) : undefined}
      badges={
        mixed ? (
          <Badge tone="hud" icon={kind.icon}>
            {kind.singular}
          </Badge>
        ) : undefined
      }
      favorite={item.favorite}
      onFavoriteChange={onFavoriteChange}
      onMore={onMore}
    />
  );
}

const UPLOAD_STATUS: Record<UploadEntry["status"], string> = {
  queued: "Waiting…",
  preparing: "Preparing…",
  uploading: "Uploading…",
  finishing: "Finishing…",
  failed: "Not uploaded",
};

export function UploadCard({ entry, onMore }: { entry: UploadEntry; onMore: (anchor: HTMLElement) => void }) {
  const failed = entry.status === "failed";
  const status = entry.status === "uploading" ? `Uploading… ${formatPercent(entry.progress)}` : UPLOAD_STATUS[entry.status];
  return (
    <MediaCard
      id={entry.id}
      title={entry.name}
      subtitle={status}
      thumbnail={entry.previewUrl}
      placeholder={<Placeholder kind={entry.plan.kind} />}
      status={failed ? "ready" : "processing"}
      progress={entry.progress}
      badges={
        failed ? (
          <Badge tone="hud" icon={CircleAlert}>
            Upload Failed
          </Badge>
        ) : undefined
      }
      description={failed ? "Upload failed" : undefined}
      onMore={onMore}
    />
  );
}
