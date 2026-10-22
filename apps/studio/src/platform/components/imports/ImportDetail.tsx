// The 3D view of one import (#/imports/<id>, APPLE_STYLE_SPEC §3.5 "Detail viewer"): ‹ Back, the title with "Blender ·
// GLB · Imported Oct 21", Download (original or GLB) and the inspector toggle in the toolbar; the model on the stage —
// the preview GLB, or the original when it is a GLB itself — with Shaded/Wireframe and Turntable in a HUD; the
// inspector with the statistics, the source and its evidence, tags and actions beside it.

import { useMemo, useState } from "react";
import { ChevronLeft, CircleAlert, Download, Info, RotateCw, Trash2, View } from "lucide-react";
import { navigate } from "../../app/router";
import { PageToolbar } from "../../app/shell/PageToolbar";
import { useAssetUrl } from "../../app/shell/queries";
import { formatShortDate } from "../../app/shell/time";
import { errorCode } from "../../app/messages";
import type { ImportedObject, SourceApp } from "../../core/types";
import {
  Button,
  EmptyState,
  IconButton,
  MenuButton,
  MenuItem,
  SegmentedControl,
  Spinner,
  ToolbarGroup,
  useDeferredLoading,
  useMediaQuery,
  useShortcuts,
} from "../../ui";
import { ModelViewer } from "../ModelViewer";
import { useAssetBlob, useImportActions, useImportedObject } from "./data";
import { ImportInspector, type ImportCommands } from "./ImportInspector";
import { RenameSheet, SourceSheet } from "./ImportSheets";
import { FORMAT_SHORT, SOURCE_LABEL, viewerAssetId } from "./model";
import "./imports.css";

type Shading = "shaded" | "wireframe";

export interface ImportDetailProps {
  objectId: string;
  /** The scope the grid was showing, kept for ‹ Back. */
  source?: SourceApp | undefined;
}

export function ImportDetail({ objectId, source }: ImportDetailProps) {
  const result = useImportedObject(objectId);
  const actions = useImportActions();
  const wide = useMediaQuery("(min-width: 1280px)");
  const [inspectorChoice, setInspectorChoice] = useState<boolean | null>(null);
  const [renaming, setRenaming] = useState<ImportedObject | null>(null);
  const [changingSource, setChangingSource] = useState<ImportedObject | null>(null);
  const inspectorShown = inspectorChoice ?? wide;
  const object = result.data && result.data.id === objectId ? result.data : undefined;

  const back = () => navigate({ name: "imports", ...(source ? { source } : {}) });
  const toggleInspector = () => setInspectorChoice(!inspectorShown);
  useShortcuts([{ keys: "mod+i", handler: toggleInspector, enabled: object !== undefined }]);

  const commands = useMemo<ImportCommands>(
    () => ({
      actions,
      onRename: setRenaming,
      onChangeSource: setChangingSource,
      onTrashed: () => navigate({ name: "imports", ...(source ? { source } : {}) }, { replace: true }),
    }),
    [actions, source],
  );

  const backButton = (
    <ToolbarGroup>
      <IconButton variant="toolbar" size="toolbar" icon={ChevronLeft} label="Back to Imports" onClick={back} />
    </ToolbarGroup>
  );

  if (!object) {
    const missing = result.error !== undefined && result.data === undefined;
    return (
      <>
        <PageToolbar leading={backButton} title="Import" />
        <div className="px-imports-detail px-imports-detail--message">
          {missing ? (
            <EmptyState
              icon={CircleAlert}
              title={errorCode(result.error) === "not_found" ? "Import Not Found" : "Couldn’t Load This Import"}
              description={
                errorCode(result.error) === "not_found"
                  ? "It may have been deleted on another device."
                  : "Check your connection and try again."
              }
              action={
                errorCode(result.error) === "not_found" ? (
                  <Button onClick={back}>Back to Imports</Button>
                ) : (
                  <Button onClick={() => void result.refresh()}>Try Again</Button>
                )
              }
            />
          ) : (
            <DeferredSpinner />
          )}
        </div>
      </>
    );
  }

  if (object.trashedAt !== null) {
    return (
      <>
        <PageToolbar leading={backButton} title={object.title} />
        <div className="px-imports-detail px-imports-detail--message">
          <EmptyState
            icon={Trash2}
            title="This Import Is in the Trash"
            description="Open the Trash to put it back."
            action={
              <>
                <Button onClick={back}>Back to Imports</Button>
                <Button variant="borderedProminent" onClick={() => navigate({ name: "trash" })}>
                  Open Trash
                </Button>
              </>
            }
          />
        </div>
      </>
    );
  }

  return (
    <>
      <PageToolbar
        leading={backButton}
        title={object.title}
        subtitle={`${SOURCE_LABEL[object.sourceApp]} · ${FORMAT_SHORT[object.format]} · Imported ${formatShortDate(object.createdAt)}`}
        trailing={
          <>
            <MenuButton
              variant="glass"
              size="toolbar"
              icon={Download}
              menu={
                <>
                  <MenuItem onSelect={() => void actions.download(object, "original")}>Original File</MenuItem>
                  <MenuItem disabled={viewerAssetId(object) === null} onSelect={() => void actions.download(object, "glb")}>
                    GLB for Viewing
                  </MenuItem>
                </>
              }
            >
              Download
            </MenuButton>
            <ToolbarGroup>
              <IconButton
                variant="toolbar"
                size="toolbar"
                icon={Info}
                label={inspectorShown ? "Hide Inspector" : "Show Inspector"}
                pressed={inspectorShown}
                shortcut="mod+i"
                onClick={toggleInspector}
              />
            </ToolbarGroup>
          </>
        }
      />
      <div className="px-imports-detail" data-inspector={inspectorShown ? "shown" : "hidden"}>
        <ImportStage key={object.id} object={object} />
        {inspectorShown ? (
          <div className="px-imports__aside">
            <ImportInspector selection={[object]} context="detail" commands={commands} />
          </div>
        ) : null}
      </div>
      <RenameSheet object={renaming} onClose={() => setRenaming(null)} onRename={(item, title) => void actions.rename(item, title)} />
      <SourceSheet object={changingSource} onClose={() => setChangingSource(null)} onChange={(item, app) => void actions.setSource(item, app)} />
    </>
  );
}

function DeferredSpinner({ label = "Loading" }: { label?: string }) {
  const visible = useDeferredLoading(true);
  return visible ? <Spinner size={32} label={label} /> : null;
}

/** The stage: the model with its HUD, or why it cannot be shown (with the thumbnail behind when there is one). */
function ImportStage({ object }: { object: ImportedObject }) {
  const viewerId = viewerAssetId(object);
  const [attempt, setAttempt] = useState(0);
  const glb = useAssetBlob(viewerId, attempt);
  const poster = useAssetUrl(object.thumbnailAssetId);
  const [shading, setShading] = useState<Shading>("shaded");
  const [turntable, setTurntable] = useState(false);
  const [viewError, setViewError] = useState<string | null>(null);
  const source = useMemo(() => (glb.blob ? { kind: "blob" as const, blob: glb.blob } : null), [glb.blob]);

  let message: { title: string; description: string; retry: boolean } | null = null;
  if (viewerId === null) {
    message = {
      title: "No 3D Preview",
      description: "A preview couldn’t be made for this file when it was imported. Download the original to open it in its app.",
      retry: false,
    };
  } else if (glb.error !== null) {
    message = { title: "The Model Couldn’t Be Downloaded", description: "Check your connection and try again.", retry: true };
  } else if (viewError !== null) {
    message = { title: "The Model Couldn’t Be Shown", description: viewError, retry: true };
  }

  return (
    <div className="px-imports-detail__stage">
      {message ? (
        <>
          {poster ? <img className="px-imports-detail__poster" src={poster} alt="" decoding="async" /> : null}
          <div className="px-imports-detail__message">
            <EmptyState
              icon={viewerId === null ? View : CircleAlert}
              title={message.title}
              description={message.description}
              action={
                message.retry ? (
                  <Button
                    onClick={() => {
                      setViewError(null);
                      setAttempt((value) => value + 1);
                    }}
                  >
                    Try Again
                  </Button>
                ) : undefined
              }
            />
          </div>
        </>
      ) : source ? (
        <>
          <ModelViewer
            key={attempt}
            className="px-imports-detail__viewer"
            source={source}
            label={`3D view of ${object.title}`}
            background="dark"
            autoRotate={turntable}
            wireframe={shading === "wireframe"}
            onError={setViewError}
          />
          <div className="px-imports-detail__hud" role="group" aria-label="View">
            <SegmentedControl<Shading>
              aria-label="Display"
              value={shading}
              onChange={setShading}
              items={[
                { value: "shaded", label: "Shaded" },
                { value: "wireframe", label: "Wireframe" },
              ]}
            />
            <IconButton icon={RotateCw} label="Turntable" pressed={turntable} onClick={() => setTurntable(!turntable)} />
          </div>
        </>
      ) : (
        <div className="px-imports-detail__message" aria-busy="true">
          <DeferredSpinner label="Loading the model" />
        </div>
      )}
    </div>
  );
}
