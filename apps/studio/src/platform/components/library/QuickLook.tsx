// Quick Look for the Library (APPLE_STYLE_SPEC §3.4): Space or Return on a card opens the item large — the image with
// zoom, the video, or the 3D model — in a sheet. ← and → step through the grid's order, Space or Escape close it and
// focus returns to the card.
import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download, FolderOpen } from "lucide-react";
import { navigate } from "../../app/router";
import { getLab } from "../../core/labs/registry";
import type { LibraryItem } from "../../core/types";
import { Button, formatBytes, IconButton, Sheet, useLatest } from "../../ui";
import { ItemPreview } from "./ItemPreview";
import { KIND_INFO } from "./kinds";
import { useLibraryItem } from "./useLibrary";
import "./library.css";

export interface QuickLookProps {
  /** The item to show; null closes the sheet. */
  item: LibraryItem | null;
  /** Where the item sits in the grid (for "3 of 12" and the arrows). */
  position: { index: number; count: number } | null;
  onClose: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onDownload: (item: LibraryItem) => void;
}

function subtitle(item: LibraryItem): string {
  const lab = item.labId ? getLab(item.labId)?.title ?? item.labId : null;
  return [KIND_INFO[item.kind].singular, lab, formatBytes(item.byteSize)].filter(Boolean).join(" · ");
}

/** Keys that belong to the focused control rather than to Quick Look. */
function ownsKey(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest("button, a[href], input, textarea, select, video, [contenteditable='true'], .px-model-viewer__stage") !== null;
}

export function QuickLook({ item, position, onClose, onPrevious, onNext, onDownload }: QuickLookProps) {
  // keep the last item through the closing fade
  const [shown, setShown] = useState<LibraryItem | null>(item);
  useEffect(() => {
    if (item) setShown(item);
  }, [item]);
  const full = useLibraryItem(shown?.id ?? null);
  const current = shown && full.data?.id === shown.id ? { ...full.data, title: shown.title, favorite: shown.favorite } : shown;
  const stage = useRef<HTMLDivElement | null>(null);
  const open = item !== null;
  const latest = useLatest({ onClose, onPrevious, onNext });

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (!(target instanceof Element) || !target.closest(".px-quicklook")) return;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        if (ownsKey(target) && !(target instanceof HTMLButtonElement)) return;
        event.preventDefault();
        if (event.key === "ArrowLeft") latest.current.onPrevious();
        else latest.current.onNext();
      } else if (event.key === " " && !ownsKey(target)) {
        event.preventDefault();
        latest.current.onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, latest]);

  const many = position !== null && position.count > 1;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={current?.title ?? ""}
      description={current ? subtitle(current) : undefined}
      size="large"
      closeButton
      className="px-quicklook"
      initialFocus={stage}
      leadingActions={
        many && position ? (
          <>
            <IconButton icon={ChevronLeft} label="Previous Item" variant="bordered" onClick={onPrevious} />
            <IconButton icon={ChevronRight} label="Next Item" variant="bordered" onClick={onNext} />
            <span className="px-quicklook__position px-num">
              {position.index + 1} of {position.count}
            </span>
          </>
        ) : null
      }
      actions={
        current ? (
          <>
            {current.sourceProjectId ? (
              <Button
                icon={FolderOpen}
                onClick={() => {
                  const projectId = current.sourceProjectId;
                  onClose();
                  if (projectId) navigate({ name: "project", id: projectId });
                }}
              >
                Open Project
              </Button>
            ) : null}
            <Button variant="borderedProminent" icon={Download} onClick={() => onDownload(current)}>
              Download
            </Button>
          </>
        ) : null
      }
    >
      <div ref={stage} tabIndex={-1} className="px-quicklook__stage">
        {current ? <ItemPreview key={current.id} item={current} variant="quicklook" /> : null}
      </div>
    </Sheet>
  );
}
