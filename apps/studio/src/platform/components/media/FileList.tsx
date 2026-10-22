// The files of a library item, one row each: type glyph, name, role and size, and a download button. A plain list
// (role="list") whose only controls are the per-row buttons, so it reads well in the inspector and in Quick Look.
import { Box, Download, File, FileArchive, FileImage, FileJson, FileText, FileVideo, type LucideIcon } from "lucide-react";
import { cx, formatBytes, Icon, IconButton, Spinner } from "../../ui";
import { fileType, type FileType } from "../library/metadata";
import "./viewers.css";

export interface FileListEntry {
  /** Unique within the list (asset id + filename). */
  key: string;
  filename: string;
  /** "Mesh", "Albedo" … */
  roleLabel?: string | undefined;
  byteSize?: number | undefined;
  mimeType?: string | undefined;
}

export interface FileListProps {
  files: readonly FileListEntry[];
  onDownload: (file: FileListEntry) => void;
  /** Keys of files being downloaded right now (their button shows a spinner). */
  busy?: ReadonlySet<string> | undefined;
  "aria-label"?: string | undefined;
  className?: string | undefined;
}

const TYPE_ICON: Record<FileType, LucideIcon> = {
  model: Box,
  image: FileImage,
  video: FileVideo,
  data: FileJson,
  text: FileText,
  archive: FileArchive,
  other: File,
};

export function FileList({ files, onDownload, busy, className, ...aria }: FileListProps) {
  return (
    <ul role="list" className={cx("px-file-list", className)} aria-label={aria["aria-label"] ?? "Files"}>
      {files.map((file) => {
        const details = [file.roleLabel, typeof file.byteSize === "number" ? formatBytes(file.byteSize) : null].filter(Boolean).join(" · ");
        const downloading = busy?.has(file.key) ?? false;
        return (
          <li key={file.key} className="px-file-list__row">
            <Icon icon={TYPE_ICON[fileType(file)]} size={16} className="px-file-list__icon" />
            <span className="px-file-list__text">
              <span className="px-file-list__name" title={file.filename}>
                {file.filename}
              </span>
              {details ? <span className="px-file-list__details px-num">{details}</span> : null}
            </span>
            {downloading ? (
              <span className="px-file-list__busy">
                <Spinner size={14} label={`Downloading “${file.filename}”`} />
              </span>
            ) : (
              <IconButton icon={Download} label={`Download “${file.filename}”`} size="small" tooltip={false} onClick={() => onDownload(file)} />
            )}
          </li>
        );
      })}
    </ul>
  );
}
