// #/lab/<labId>: a lab opened without a project — guests trying VISCERA, or "New Project" before the first save
// (DESIGN.md D14). Nothing is saved until "Save as Project…" (⌘S) creates the project from what the lab shows; then the
// project editor takes over. Labs without a session adapter can still record and add snapshots to the Library.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CircleAlert, CircleDashed, LogIn, Save } from "lucide-react";
import { useAuth, useBackend } from "../../app/context";
import { invalidate, useQuery } from "../../app/query";
import { navigate } from "../../app/router";
import type { LabNavigationRequest } from "../../core/labs/navigation";
import { getLab, labUrl, type LabDefinition } from "../../core/labs/registry";
import { ProjectSession } from "../../core/versioning";
import { Alert, Button, Icon, Tooltip, useShortcuts, useToast } from "../../ui";
import { AddToLibraryMenu, type LibrarySource } from "../../components/lab/AddToLibraryMenu";
import { editorFingerprint, editorSnapshots, labReloader } from "../../components/lab/editorSession";
import { useLabBusy, useLeavePrompt, useUsage } from "../../components/lab/hooks";
import { LabFrame, type LabFrameHandlers, type LabHandle } from "../../components/lab/LabFrame";
import { NameSheet } from "../../components/lab/NameSheet";
import { ProjectBar } from "../../components/lab/ProjectBar";
import { RecordButton, RecordSheet } from "../../components/lab/RecordSheet";
import { useLabRecorder } from "../../components/lab/useLabRecorder";
import { StageBanner, StageMessage } from "./ProjectEditorPage";
import { defaultProjectTitle } from "./projectList";
import "../../components/lab/lab.css";

export interface LabScratchPageProps {
  labId: string;
}

/** How long a lab may take to register its session before saving is reported as unavailable. */
const ADAPTER_TIMEOUT_MS = 20_000;
const FALLBACK_MAX_FILE_BYTES = 50 * 1024 * 1024;

type Saving = "pending" | "available" | "unavailable";

export default function LabScratchPage({ labId }: LabScratchPageProps) {
  const lab = getLab(labId);
  if (!lab) {
    return (
      <div className="px-editor">
        <ProjectBar backLabel="VISCERA" onBack={() => navigate({ name: "home" })} title={<h1 className="px-pbar__title">Lab Not Found</h1>} />
        <div className="px-editor__body">
          <StageMessage
            icon={CircleAlert}
            title="This Lab Doesn't Exist"
            text={`There is no lab called “${labId}”.`}
            actions={
              <Button size="large" variant="borderedProminent" onClick={() => navigate({ name: "home" })}>
                Back to VISCERA
              </Button>
            }
          />
        </div>
      </div>
    );
  }
  return <ScratchLab key={lab.id} lab={lab} />;
}

function ScratchLab({ lab }: { lab: LabDefinition }) {
  const backend = useBackend();
  const auth = useAuth();
  const toast = useToast();
  const usage = useUsage();
  const signedIn = auth.status === "signed-in";
  const [handle, setHandle] = useState<LabHandle | null>(null);
  const [saving, setSaving] = useState<Saving>(lab.capabilities.projects ? "pending" : "unavailable");
  const [suggestedTitle, setSuggestedTitle] = useState(lab.title);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [edited, setEdited] = useState(false);
  const [leaveTarget, setLeaveTarget] = useState<(() => void) | null>(null);
  const created = useRef<ProjectSession | null>(null);
  const busy = useLabBusy(handle?.connection ?? null);
  const recorder = useLabRecorder(handle, lab.id, usage?.maxFileBytes ?? null);
  const src = useMemo(() => labUrl(lab), [lab]);
  // existing titles, so the suggestion does not repeat one ("Organ Design 2")
  const { data: projects } = useQuery(signedIn ? "projects:list" : null, () => backend.projects.list({ orderBy: "updated" }));

  useEffect(() => {
    const previous = document.title;
    document.title = `${lab.title} — VISCERA`;
    return () => {
      document.title = previous;
    };
  }, [lab.title]);

  // the lab's session adapter: present → projects can be saved; none within the timeout → saving is not available yet
  useEffect(() => {
    if (!handle) return undefined;
    const connection = handle.connection;
    const update = () => {
      const adapter = connection.adapter();
      if (adapter) setSaving(lab.capabilities.projects ? "available" : "unavailable");
    };
    update();
    const offAdapter = connection.onAdapter(update);
    const offChange = connection.onChange((kind) => {
      if (kind === "document") setEdited(true);
    });
    let alive = true;
    connection.ready().then(update, () => {
      if (alive && !connection.adapter()) setSaving("unavailable");
    });
    return () => {
      alive = false;
      offAdapter();
      offChange();
    };
  }, [handle, lab.capabilities.projects]);

  // a session created by "Save as Project" is handed over to the editor: flush it and let it go when leaving
  useEffect(
    () => () => {
      const session = created.current;
      created.current = null;
      if (session) void session.flush({ close: true }).finally(() => session.dispose());
    },
    [],
  );

  const unsaved = signedIn && saving === "available" && edited;
  const pending = useCallback(() => unsaved || recorder.phase !== "idle", [unsaved, recorder.phase]);
  useLeavePrompt(pending);

  const leave = useCallback(
    (go: () => void) => {
      if (pending()) setLeaveTarget(() => go);
      else go();
    },
    [pending],
  );

  const openSave = useCallback(() => {
    if (!signedIn) {
      navigate({ name: "signin", next: `/lab/${lab.id}` });
      return;
    }
    if (saving !== "available") {
      toast.show({ message: `Saving projects isn't available in ${lab.title} yet. You can still record and add snapshots to the Library.`, tone: "info" });
      return;
    }
    const described = handle?.connection.adapter()?.describe?.();
    setSuggestedTitle(defaultProjectTitle(described?.title ?? null, lab.title, (projects ?? []).map((project) => project.title)));
    setSheetOpen(true);
  }, [signedIn, saving, handle, lab, projects, toast]);

  useShortcuts([{ keys: "mod+s", allowInEditable: true, handler: openSave }]);

  const onNavigate = useCallback(
    (request: LabNavigationRequest) => {
      if (request.labId && request.labId !== lab.id && (request.reason === "lab" || request.reason === "top")) {
        const target = request.labId;
        leave(() => navigate({ name: "lab", labId: target }));
        return;
      }
      if (request.reason === "same-lab" || request.labId === lab.id) {
        toast.show({ message: "That link would reload the lab and lose what it shows.", tone: "info" });
        return;
      }
      window.open(request.url, "_blank", "noopener,noreferrer");
    },
    [lab.id, leave, toast],
  );

  const handlers = useMemo<LabFrameHandlers>(() => ({ onSave: openSave, onSaveNamed: openSave, onNavigate }), [openSave, onNavigate]);

  const saveAsProject = async (title: string) => {
    if (!handle) throw new Error("The lab isn't ready yet.");
    const session = await ProjectSession.createProject({
      projects: backend.projects,
      snapshots: editorSnapshots(backend.assets, () => usage?.maxFileBytes ?? FALLBACK_MAX_FILE_BYTES),
      lab: handle.connection,
      labId: lab.id,
      title,
      reloadLab: labReloader(handle.connection, lab.id),
      fingerprint: editorFingerprint,
      // the editor opens the project with its own journal and lock; this one only creates it
      journal: null,
    });
    created.current = session;
    invalidate("projects");
    invalidate("account:usage");
    setEdited(false);
    toast.show({ message: `Saved “${session.project.title}”. Changes now save automatically.`, tone: "success" });
    navigate({ name: "project", id: session.project.id });
  };

  const source: LibrarySource = { labId: lab.id, labTitle: lab.title, projectId: null, versionId: null, unsavedChanges: false };

  const subtitle = (
    <>
      <span className="px-pbar__lab">{lab.title}</span>
      <span className="px-pbar__dot" aria-hidden="true">
        ·
      </span>
      <span className="px-pbar-status" data-tone="neutral">
        <Icon icon={CircleDashed} size={11} className="px-pbar-status__icon" />
        <span className="px-pbar-status__text">{signedIn ? "Not saved" : "Not saved — sign in to keep your work"}</span>
      </span>
    </>
  );

  const saveButton = signedIn ? (
    saving === "available" ? (
      <Tooltip content="Save as Project" shortcut="mod+s">
        <Button size="large" variant="borderedProminent" icon={Save} className="px-pbar__button" onClick={openSave}>
          Save as Project…
        </Button>
      </Tooltip>
    ) : (
      <Tooltip
        content={
          saving === "pending" ? "Waiting for the lab to finish loading." : `${lab.title} can't be saved as a project yet. Record or add snapshots to the Library instead.`
        }
      >
        <Button size="large" variant="borderedProminent" icon={Save} className="px-pbar__button" aria-disabled onClick={openSave}>
          {saving === "pending" ? "Save as Project…" : "Saving Not Available Yet"}
        </Button>
      </Tooltip>
    )
  ) : (
    <Button size="large" variant="borderedProminent" icon={LogIn} className="px-pbar__button" onClick={() => navigate({ name: "signin", next: `/lab/${lab.id}` })}>
      Sign In to Save
    </Button>
  );

  return (
    <div className="px-editor">
      <ProjectBar
        backLabel="VISCERA"
        onBack={() => leave(() => navigate({ name: signedIn ? "projects" : "home" }))}
        title={<h1 className="px-pbar__title">Untitled</h1>}
        subtitle={subtitle}
        trailing={
          <>
            {signedIn ? (
              <>
                <RecordButton recorder={recorder} busy={recorder.phase === "idle" ? busy : false} disabled={!handle} onError={(message) => toast.show({ message, tone: "warning" })} />
                <span className="px-pbar__hide-narrow">
                  <AddToLibraryMenu handle={handle} source={source} baseTitle={lab.title} busy={busy} disabled={!handle} />
                </span>
              </>
            ) : null}
            {saveButton}
          </>
        }
      />
      <div className="px-editor__body">
        <section className="px-editor__stage" aria-label={`${lab.title} lab`}>
          <LabFrame src={src} labId={lab.id} title={lab.title} onConnect={setHandle} handlers={handlers} timeoutMs={ADAPTER_TIMEOUT_MS} />
          {signedIn && saving === "unavailable" && lab.capabilities.projects ? (
            <StageBanner icon={CircleAlert}>Saving projects isn't available in this lab yet. Record and Add to Library still work.</StageBanner>
          ) : null}
        </section>
      </div>
      <NameSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title="Save as Project"
        description="The project keeps what the lab shows now. From then on, changes save automatically and versions build up as you work."
        initialValue={suggestedTitle}
        submitLabel="Save"
        failure="The project couldn't be saved."
        onSubmit={saveAsProject}
      />
      <Alert
        open={leaveTarget !== null}
        onClose={() => setLeaveTarget(null)}
        title={recorder.phase !== "idle" ? "Leave and Discard the Recording?" : "Leave Without Saving?"}
        message={
          recorder.phase !== "idle"
            ? "The recording has not been added to the Library."
            : "What the lab shows has not been saved as a project and will be lost."
        }
        actionLabel="Leave"
        destructive
        onAction={() => {
          const go = leaveTarget;
          setLeaveTarget(null);
          recorder.discard();
          setEdited(false);
          go?.();
        }}
      />
      <RecordSheet recorder={recorder} source={source} baseTitle={lab.title} />
    </div>
  );
}
