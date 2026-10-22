// Files from a drop or a file picker, folders included. A file inside a dropped folder keeps its path in that folder as
// webkitRelativePath (what a folder picker sets, and what the importer reads), so a glTF finds "textures/wood.png"
// next to it and the original keeps the folder's layout. importGroups then splits them into imports for the queue.

import { planImports, sizeRefusal } from "./model";
import type { EnqueueGroup } from "./queue";

/** A dropped folder is walked up to this many files; a whole project tree is not an import. */
export const MAX_DROPPED_FILES = 1000;

export interface CollectedFiles {
  files: File[];
  /** The walk stopped at MAX_DROPPED_FILES. */
  truncated: boolean;
}

/** The path the importer and the grouping see: the folder path for files from folders, else the name. */
export function filePath(file: File): string {
  return (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
}

function withRelativePath(file: File, path: string): File {
  // webkitRelativePath is a read-only getter on File.prototype; an own property on the instance shadows it
  try {
    Object.defineProperty(file, "webkitRelativePath", { value: path, configurable: true, enumerable: true });
  } catch {
    // a frozen File keeps its plain name; the importer still resolves companions by name
  }
  return file;
}

/** True when a drag carries files (not text or a link), so the page only reacts to drops it can import. */
export function dragHasFiles(dataTransfer: DataTransfer | null): boolean {
  return dataTransfer !== null && Array.from(dataTransfer.types).includes("Files");
}

export interface DropSnapshot {
  entries: FileSystemEntry[];
  files: File[];
}

/**
 * Reads what was dropped. Must run synchronously inside the drop handler: a DataTransfer's items are only readable
 * while the event is dispatched; the entries it returns stay usable afterwards.
 */
export function snapshotDrop(dataTransfer: DataTransfer): DropSnapshot {
  const entries: FileSystemEntry[] = [];
  for (const item of Array.from(dataTransfer.items)) {
    if (item.kind !== "file") continue;
    const entry = typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null;
    if (entry) entries.push(entry);
  }
  return { entries, files: Array.from(dataTransfer.files) };
}

function skipDirectory(name: string): boolean {
  return name.startsWith(".") || name === "__MACOSX" || name === "node_modules";
}

function readBatch(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

function fileOf(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

/** Expands dropped folders into their files (each with its path inside the drop). */
export async function collectDrop(snapshot: DropSnapshot): Promise<CollectedFiles> {
  if (snapshot.entries.length === 0) return { files: snapshot.files.slice(0, MAX_DROPPED_FILES), truncated: snapshot.files.length > MAX_DROPPED_FILES };
  const files: File[] = [];
  let truncated = false;
  const visit = async (entry: FileSystemEntry): Promise<void> => {
    if (files.length >= MAX_DROPPED_FILES) {
      truncated = true;
      return;
    }
    if (entry.isFile) {
      const file = await fileOf(entry as FileSystemFileEntry);
      const path = entry.fullPath.replace(/^\/+/, "");
      files.push(path.includes("/") ? withRelativePath(file, path) : file);
      return;
    }
    if (!entry.isDirectory || skipDirectory(entry.name)) return;
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries answers in batches (100 in Chrome) until it returns an empty one
    for (let batch = await readBatch(reader); batch.length > 0; batch = await readBatch(reader)) {
      for (const child of batch) await visit(child);
    }
  };
  for (const entry of snapshot.entries) await visit(entry);
  return { files, truncated };
}

/** Files chosen with the picker (a folder picker already sets webkitRelativePath). */
export function collectPicked(list: FileList | null): CollectedFiles {
  const files = list ? Array.from(list) : [];
  return { files: files.slice(0, MAX_DROPPED_FILES), truncated: files.length > MAX_DROPPED_FILES };
}

const SIZE_ADVICE = "Leave out files the model doesn’t use, or reduce its textures, and export again.";

/**
 * The imports a set of files makes (see planImports), each checked against the plan's per-file limit before any byte
 * is read; `maxBytes` is null while the plan is still loading (the importer checks again before reading).
 */
export function importGroups(files: readonly File[], maxBytes: number | null): { groups: EnqueueGroup[]; ignored: string[] } {
  const infos = files.map((file) => ({ path: filePath(file), size: file.size }));
  const plan = planImports(infos);
  const groups = plan.groups.map((group): EnqueueGroup => {
    const refusal = maxBytes === null ? null : sizeRefusal(infos, group, maxBytes);
    return {
      label: group.label,
      files: group.files.flatMap((index) => (files[index] ? [files[index]] : [])),
      sniffFirst: group.kind === "refused",
      ...(refusal ? { failure: { reason: refusal, advice: SIZE_ADVICE, retryable: false } } : {}),
    };
  });
  return { groups, ignored: plan.ignored.flatMap((index) => (infos[index] ? [infos[index].path] : [])) };
}
