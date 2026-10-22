// The large preview of a library item (inspector and Quick Look): its mesh in the 3D viewer, its image with zoom, its
// video, or its stored thumbnail. Images and videos stream from signed URLs; a model's bytes come through the asset
// cache (verified by SHA-256 and kept locally, so reopening an item does not download it again).
import { useEffect, useMemo, useState } from "react";
import { useBackend } from "../../app/context";
import { useAssetUrl } from "../../app/shell/queries";
import type { LibraryItem, Uuid } from "../../core/types";
import { cx, Icon } from "../../ui";
import { ModelViewer, type ModelSource } from "../ModelViewer";
import { ImageViewer } from "../media/ImageViewer";
import { VideoPlayer, type VideoInfo } from "../media/VideoPlayer";
import type { Size } from "../media/zoom";
import { KIND_INFO } from "./kinds";
import { choosePreview } from "./metadata";
import "./library.css";

export interface ItemPreviewProps {
  item: LibraryItem;
  variant: "inspector" | "quicklook";
  onModelStats?: ((stats: { vertices: number; triangles: number; meshes: number }) => void) | undefined;
  onImageSize?: ((size: Size) => void) | undefined;
  onVideoInfo?: ((info: VideoInfo) => void) | undefined;
}

/** The bytes of an asset through the verified local cache; null while loading. */
function useAssetBlob(assetId: Uuid | null): { blob: Blob | null; failed: boolean } {
  const backend = useBackend();
  const [state, setState] = useState<{ id: Uuid | null; blob: Blob | null; failed: boolean }>({ id: null, blob: null, failed: false });
  useEffect(() => {
    if (!assetId) return undefined;
    const controller = new AbortController();
    setState({ id: assetId, blob: null, failed: false });
    backend.assets.get(assetId, { signal: controller.signal }).then(
      (blob) => {
        if (!controller.signal.aborted) setState({ id: assetId, blob, failed: false });
      },
      () => {
        if (!controller.signal.aborted) setState({ id: assetId, blob: null, failed: true });
      },
    );
    return () => controller.abort();
  }, [backend, assetId]);
  return state.id === assetId ? { blob: state.blob, failed: state.failed } : { blob: null, failed: false };
}

export function ItemPreview({ item, variant, onModelStats, onImageSize, onVideoInfo }: ItemPreviewProps) {
  const choice = choosePreview(item);
  const fileAssetId = choice.type === "model" || choice.type === "image" || choice.type === "video" ? choice.file.assetId : null;
  const fileUrl = useAssetUrl(choice.type === "image" || choice.type === "video" ? fileAssetId : null);
  const thumbnailUrl = useAssetUrl(item.thumbnailAssetId);
  const model = useAssetBlob(choice.type === "model" ? fileAssetId : null);
  const modelSource = useMemo<ModelSource | null>(() => (model.blob ? { kind: "blob", blob: model.blob } : null), [model.blob]);
  const quickLook = variant === "quicklook";
  const name = item.title;

  const className = cx("px-item-preview", `px-item-preview--${variant}`);
  switch (choice.type) {
    case "model":
      return (
        <div className={className}>
          <ModelViewer
            source={model.failed ? null : modelSource}
            label={`3D preview of ${name}`}
            autoRotate={!quickLook}
            onStats={onModelStats}
          />
          {model.failed ? <p className="px-item-preview__note">The model couldn’t be downloaded.</p> : null}
        </div>
      );
    case "image":
      return (
        <div className={className}>
          <ImageViewer
            src={fileUrl}
            alt={item.kind === "image" ? name : `${KIND_INFO[item.kind].singular} preview of ${name}`}
            checkerboard
            compact={!quickLook}
            onSize={onImageSize}
          />
        </div>
      );
    case "video":
      return (
        <div className={className}>
          <VideoPlayer src={fileUrl} poster={thumbnailUrl} label={`Recording “${name}”`} onInfo={onVideoInfo} />
        </div>
      );
    case "thumbnail":
      return (
        <div className={className}>
          <ImageViewer src={thumbnailUrl} alt={`Thumbnail of ${name}`} compact={!quickLook} />
        </div>
      );
    case "none":
      return (
        <div className={cx(className, "px-item-preview--empty")}>
          <Icon icon={KIND_INFO[item.kind].icon} size={quickLook ? 56 : 40} />
          <span>No Preview</span>
        </div>
      );
  }
}
