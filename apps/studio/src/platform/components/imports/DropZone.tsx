// Where files go: the large zone of an empty Imports page, the strip above the grid, and the overlay that covers the
// content column while files are dragged over it (APPLE_STYLE_SPEC §3.5 "Drop zone states").

import { FolderOpen, Import } from "lucide-react";
import { Button, Icon } from "../../ui";
import { formatLimit } from "./model";

const FORMATS = "GLB · glTF · FBX · OBJ · STL · PLY · USDZ · ZIP";

export interface ImportDropZoneProps {
  variant: "empty" | "strip";
  /** The plan's per-file limit (null while it loads). */
  limitBytes: number | null;
  onChooseFiles: () => void;
  onChooseFolder: () => void;
}

export function ImportDropZone({ variant, limitBytes, onChooseFiles, onChooseFolder }: ImportDropZoneProps) {
  const limit = limitBytes !== null ? ` Up to ${formatLimit(limitBytes)} per file.` : "";
  if (variant === "empty") {
    return (
      <div className="px-imports-drop px-imports-drop--empty">
        <Icon icon={Import} size={40} className="px-imports-drop__icon" />
        <h2 className="px-imports-drop__title">Bring In Your Models</h2>
        <p className="px-imports-drop__line">Drop exports from Unity, Blender or any other 3D app here, or choose them.</p>
        <p className="px-imports-drop__line px-num">
          {FORMATS}, with their .bin, .mtl and textures.{limit}
        </p>
        <div className="px-imports-drop__actions">
          <Button size="large" variant="bordered" icon={Import} onClick={onChooseFiles}>
            Import Files…
          </Button>
          <Button size="large" variant="plain" icon={FolderOpen} onClick={onChooseFolder}>
            Import a Folder…
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="px-imports-drop px-imports-drop--strip">
      <Icon icon={Import} size={20} className="px-imports-drop__icon" />
      <div className="px-imports-drop__text">
        <p className="px-imports-drop__title">Drop Unity or Blender exports here</p>
        <p className="px-imports-drop__line px-num">
          {FORMATS} (with .bin, .mtl and textures).{limit}
        </p>
      </div>
      <div className="px-imports-drop__actions">
        <Button variant="plain" icon={FolderOpen} onClick={onChooseFolder}>
          Import a Folder…
        </Button>
      </div>
    </div>
  );
}

/** Shown while files are dragged over the content; the drop itself is handled by the page. */
export function DropOverlay() {
  return (
    <div className="px-imports-overlay-layer" aria-hidden="true">
      <div className="px-imports-overlay">
        <span className="px-imports-overlay__chip">
          <Icon icon={Import} size={16} />
          Drop to Import
        </span>
      </div>
    </div>
  );
}
