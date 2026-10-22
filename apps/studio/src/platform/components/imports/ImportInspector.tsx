// The inspector of the Imports space (APPLE_STYLE_SPEC §2.10, §3.5): for one object its source application with the
// evidence behind it, the file, the geometry and materials the importer counted, its notes and tags, and the actions;
// for several, a summary and Move to Trash; for none, "No Selection". Also the shared action menu of an import.

import { Box, Download, Ellipsis, Heart, Info, PencilLine, Trash2, View } from "lucide-react";
import { useAssetUrl } from "../../app/shell/queries";
import { formatDateTime } from "../../app/shell/time";
import type { ImportedObject } from "../../core/types";
import {
  Button,
  formatBytes,
  Icon,
  Inspector,
  InspectorPlaceholder,
  InspectorRow,
  InspectorSection,
  MenuButton,
  MenuItem,
  MenuSeparator,
} from "../../ui";
import type { ImportActions } from "./data";
import {
  DETECTED_BY_LABEL,
  detectionSummary,
  FORMAT_NAME,
  formatBounds,
  SOURCE_LABEL,
  unitsLabel,
  viewerAssetId,
} from "./model";
import { TagEditor } from "./TagEditor";

const NUMBER = new Intl.NumberFormat("en-US");

export interface ImportCommands {
  actions: ImportActions;
  /** Opens the 3D view (absent inside it). */
  onOpen?: ((object: ImportedObject) => void) | undefined;
  onRename: (object: ImportedObject) => void;
  onChangeSource: (object: ImportedObject) => void;
  /** After Move to Trash (the detail view goes back to the grid). */
  onTrashed?: ((objects: readonly ImportedObject[]) => void) | undefined;
}

/** Open · Download Original · Download GLB · Favorite · Rename… · Change Source… · Move to Trash. */
export function ImportMenuItems({ object, commands, selection }: { object: ImportedObject; commands: ImportCommands; selection?: readonly ImportedObject[] | undefined }) {
  const { actions } = commands;
  const many = selection && selection.length > 1 && selection.some((item) => item.id === object.id) ? selection : null;
  const trash = () => {
    const objects = many ?? [object];
    void actions.moveToTrash(objects).then((moved) => {
      if (moved) commands.onTrashed?.(objects);
    });
  };
  if (many) {
    const allFavorite = many.every((item) => item.favorite);
    return (
      <>
        <MenuItem icon={Heart} onSelect={() => void actions.setFavorite(many, !allFavorite)}>
          {allFavorite ? "Remove from Favorites" : "Add to Favorites"}
        </MenuItem>
        <MenuSeparator />
        <MenuItem icon={Trash2} destructive onSelect={trash}>
          {`Move ${many.length} Imports to Trash`}
        </MenuItem>
      </>
    );
  }
  return (
    <>
      {commands.onOpen ? (
        <>
          <MenuItem icon={View} onSelect={() => commands.onOpen?.(object)}>
            Open
          </MenuItem>
          <MenuSeparator />
        </>
      ) : null}
      <MenuItem icon={Download} onSelect={() => void actions.download(object, "original")}>
        Download Original
      </MenuItem>
      <MenuItem icon={Download} disabled={viewerAssetId(object) === null} onSelect={() => void actions.download(object, "glb")}>
        Download GLB
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon={Heart} onSelect={() => void actions.setFavorite([object], !object.favorite)}>
        {object.favorite ? "Remove from Favorites" : "Add to Favorites"}
      </MenuItem>
      <MenuItem icon={PencilLine} onSelect={() => commands.onRename(object)}>
        Rename…
      </MenuItem>
      <MenuItem icon={Box} onSelect={() => commands.onChangeSource(object)}>
        Change Source…
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon={Trash2} destructive onSelect={trash}>
        Move to Trash
      </MenuItem>
    </>
  );
}

export interface ImportInspectorProps {
  selection: readonly ImportedObject[];
  context: "grid" | "detail";
  commands: ImportCommands;
}

export function ImportInspector({ selection, context, commands }: ImportInspectorProps) {
  if (selection.length === 0) {
    return (
      <Inspector aria-label="Import Details">
        <InspectorPlaceholder>No Selection</InspectorPlaceholder>
      </Inspector>
    );
  }
  if (selection.length > 1) return <SelectionSummary selection={selection} commands={commands} />;
  const object = selection[0]!;
  return <ObjectInspector object={object} context={context} commands={commands} />;
}

function SelectionSummary({ selection, commands }: { selection: readonly ImportedObject[]; commands: ImportCommands }) {
  const groups = new Map<string, number>();
  for (const object of selection) {
    const name = SOURCE_LABEL[object.sourceApp];
    groups.set(name, (groups.get(name) ?? 0) + 1);
  }
  const total = selection.reduce((sum, object) => sum + object.byteSize, 0);
  const trash = () => {
    void commands.actions.moveToTrash(selection).then((moved) => {
      if (moved) commands.onTrashed?.(selection);
    });
  };
  return (
    <Inspector
      aria-label="Import Details"
      title={`${NUMBER.format(selection.length)} Imports`}
      footer={
        <Button variant="destructive" icon={Trash2} onClick={trash}>
          Move to Trash
        </Button>
      }
    >
      <InspectorSection title="Selection" persistKey="imports-selection">
        {[...groups.entries()].map(([name, count]) => (
          <InspectorRow key={name} label={name}>
            <span className="px-num">{NUMBER.format(count)}</span>
          </InspectorRow>
        ))}
        <InspectorRow label="Size">
          <span className="px-num">{formatBytes(total)}</span>
        </InspectorRow>
      </InspectorSection>
    </Inspector>
  );
}

function ObjectInspector({ object, context, commands }: { object: ImportedObject; context: "grid" | "detail"; commands: ImportCommands }) {
  const { stats } = object;
  const thumbnail = useAssetUrl(context === "grid" ? object.thumbnailAssetId : null);
  const bounds = formatBounds(stats);
  const notes = stats.notes ?? [];
  const more = (
    <MenuButton
      variant="bordered"
      icon={Ellipsis}
      chevron={false}
      aria-label="More Actions"
      className="px-imports-more"
      placement="top-end"
      menu={<ImportMenuItems object={object} commands={{ ...commands, onOpen: context === "grid" ? commands.onOpen : undefined }} />}
    />
  );
  return (
    <Inspector
      aria-label="Import Details"
      title={object.title}
      preview={
        context === "grid" ? (
          thumbnail ? (
            <img src={thumbnail} alt="" width={248} height={186} decoding="async" />
          ) : (
            <span className="px-imports-inspector__preview-glyph">
              <Icon icon={Box} size={44} />
            </span>
          )
        ) : null
      }
      footer={
        context === "grid" && commands.onOpen ? (
          <>
            <Button variant="borderedProminent" onClick={() => commands.onOpen?.(object)}>
              Open
            </Button>
            {more}
          </>
        ) : (
          <>
            <Button variant="bordered" icon={Download} onClick={() => void commands.actions.download(object, "original")}>
              Download Original
            </Button>
            {more}
          </>
        )
      }
    >
      <InspectorSection title="Source" persistKey="imports-source">
        <InspectorRow label="App">{SOURCE_LABEL[object.sourceApp]}</InspectorRow>
        <InspectorRow label="Detected By">{DETECTED_BY_LABEL[object.detectedBy]}</InspectorRow>
        {object.sourceDetail ? <InspectorRow label="Exporter">{object.sourceDetail}</InspectorRow> : null}
        <p className="px-imports-inspector__evidence">{detectionSummary(object)}</p>
        <div className="px-imports-inspector__actions">
          <Button size="small" variant="bordered" onClick={() => commands.onChangeSource(object)}>
            Change Source…
          </Button>
        </div>
      </InspectorSection>
      <InspectorSection title="File" persistKey="imports-file">
        <InspectorRow label="Format">{FORMAT_NAME[object.format]}</InspectorRow>
        <InspectorRow label="Size">
          <span className="px-num">{formatBytes(object.byteSize)}</span>
        </InspectorRow>
        <InspectorRow label="Imported">{formatDateTime(object.createdAt)}</InspectorRow>
      </InspectorSection>
      <InspectorSection title="Geometry" persistKey="imports-geometry">
        <InspectorRow label="Meshes">
          <span className="px-num">{NUMBER.format(stats.meshes)}</span>
        </InspectorRow>
        <InspectorRow label="Vertices">
          <span className="px-num">{NUMBER.format(stats.vertices)}</span>
        </InspectorRow>
        <InspectorRow label="Triangles">
          <span className="px-num">{NUMBER.format(stats.triangles)}</span>
        </InspectorRow>
        <InspectorRow label="Size">
          <span className="px-num">{bounds ?? "Not measured"}</span>
        </InspectorRow>
        <InspectorRow label="Units">{unitsLabel(stats.units)}</InspectorRow>
        <InspectorRow label="Up Axis">{stats.upAxis ?? "Not declared"}</InspectorRow>
        <InspectorRow label="Skinned">{stats.skinned ? "Yes" : "No"}</InspectorRow>
        <InspectorRow label="Animations">
          <span className="px-num">{NUMBER.format(stats.animations)}</span>
        </InspectorRow>
      </InspectorSection>
      <InspectorSection title="Materials" persistKey="imports-materials">
        <InspectorRow label="Materials">
          <span className="px-num">{NUMBER.format(stats.materials)}</span>
        </InspectorRow>
        <InspectorRow label="Textures">
          <span className="px-num">{NUMBER.format(stats.textures)}</span>
        </InspectorRow>
      </InspectorSection>
      {notes.length > 0 ? (
        <InspectorSection title={notes.length === 1 ? "1 Note" : `${notes.length} Notes`} persistKey="imports-notes">
          <ul role="list" className="px-imports-notes">
            {notes.map((note) => (
              <li key={note} className="px-imports-notes__item">
                <Icon icon={Info} size={14} />
                <span>{note}</span>
              </li>
            ))}
          </ul>
        </InspectorSection>
      ) : null}
      <InspectorSection title="Tags" persistKey="imports-tags">
        <TagEditor tags={object.tags} itemName={object.title} onChange={(tags) => void commands.actions.setTags(object, tags)} />
      </InspectorSection>
    </Inspector>
  );
}
