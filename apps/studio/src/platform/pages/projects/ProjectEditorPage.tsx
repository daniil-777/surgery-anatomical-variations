// #/projects/<id>: a lab inside a project, Adobe-style (DESIGN.md §6, §9, §15.5–15.6; APPLE_STYLE_SPEC §3.6). The lab
// runs in a same-origin iframe opened with restore=pending; a ProjectSession journals every change on this device,
// autosaves the cloud draft, commits versions (⌘S, ⇧⌘S, checkpoints), restores non-destructively and resolves conflicts
// with other tabs and devices. A second tab of the same project opens read-only until "Edit Here".

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { BookmarkPlus, Check, CircleAlert, CopyPlus, History, Lock, PencilLine, Save, Trash2, TriangleAlert, type LucideIcon } from "lucide-react";
import { useAuth, useBackend } from "../../app/context";
import { invalidate } from "../../app/query";
import { navigate } from "../../app/router";
import type { LabNavigationRequest } from "../../core/labs/navigation";
import { getLab, labUrl, type LabDefinition } from "../../core/labs/registry";
import type { Project, ProjectVersion } from "../../core/types";
import { createProjectLock, ProjectSession, type SessionState } from "../../core/versioning";
import { Alert, Button, Icon, IconButton, MenuItem, MenuSeparator, Spinner, useHud, useShortcuts, useToast } from "../../ui";
import { AddToLibraryMenu, type LibrarySource } from "../../components/lab/AddToLibraryMenu";
import { ConflictSheet, type ConflictChoice } from "../../components/lab/ConflictSheet";
import { acquireLockPatiently, editorFingerprint, editorSnapshots, labReloader, takeProjectTurn } from "../../components/lab/editorSession";
import type { EditorStatusAction } from "../../components/lab/editorStatus";
import { friendlyError, isCancellation } from "../../components/lab/friendlyError";
import { useFlushOnHide, useLabBusy, useLeavePrompt, useUsage } from "../../components/lab/hooks";
import { LabFrame, type LabFrameHandlers, type LabHandle } from "../../components/lab/LabFrame";
import { NameSheet } from "../../components/lab/NameSheet";
import { EditableTitle, IconMenuButton, ProjectBar, SaveStatus } from "../../components/lab/ProjectBar";
import { RecordButton, RecordSheet } from "../../components/lab/RecordSheet";
import { RecoverSheet } from "../../components/lab/RecoverSheet";
import { RestoreReviewSheet } from "../../components/lab/RestoreReviewSheet";
import { useLabRecorder } from "../../components/lab/useLabRecorder";
import { nextVersionName, versionTitle } from "../../components/lab/versionHistory";
import { VersionHistoryPanel, versionsKey } from "../../components/lab/VersionHistoryPanel";
import { copyTitle } from "./projectList";
import "../../components/lab/lab.css";

export interface ProjectEditorPageProps {
  projectId: string;
}

const HISTORY_KEY = "viscera.px.editor.history.v1";
const FALLBACK_MAX_FILE_BYTES = 50 * 1024 * 1024;

function readHistoryOpen(): boolean {
  try {
    return window.localStorage.getItem(HISTORY_KEY) === "1";
  } catch {
    return false;
  }
}

function writeHistoryOpen(open: boolean): void {
  try {
    window.localStorage.setItem(HISTORY_KEY, open ? "1" : "0");
  } catch {
    // a per-viewer convenience: private windows simply forget it
  }
}

/** Loads the project fresh (never from a list cache: the session must start from the server's newest state). */
export default function ProjectEditorPage({ projectId }: ProjectEditorPageProps) {
  const backend = useBackend();
  const auth = useAuth();
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (auth.status !== "signed-in") return undefined;
    let alive = true;
    setError(null);
    backend.projects.get(projectId).then(
      (record) => {
        if (alive) setProject(record);
      },
      (reason: unknown) => {
        if (alive) setError(reason);
      },
    );
    return () => {
      alive = false;
    };
  }, [backend, projectId, auth.status, generation]);

  if (auth.status === "signed-out") {
    return (
      <EditorShell title="Project" onBack={() => navigate({ name: "home" })} backLabel="VISCERA">
        <StageMessage
          icon={Lock}
          title="Sign In to Open This Project"
          text="Projects are saved to your account."
          actions={
            <Button size="large" variant="borderedProminent" onClick={() => navigate({ name: "signin", next: `/projects/${projectId}` })}>
              Sign In
            </Button>
          }
        />
      </EditorShell>
    );
  }
  if (error) {
    const missing = typeof error === "object" && error !== null && (error as { code?: unknown }).code === "not_found";
    return (
      <EditorShell title="Project" onBack={() => navigate({ name: "projects" })} backLabel="Projects">
        <StageMessage
          icon={CircleAlert}
          title={missing ? "This Project Doesn't Exist" : "Couldn't Open the Project"}
          text={missing ? "It may have been deleted, or it belongs to another account." : friendlyError(error, "Check your connection and try again.")}
          actions={
            <>
              <Button size="large" onClick={() => navigate({ name: "projects" })}>
                Show Projects
              </Button>
              {missing ? null : (
                <Button size="large" variant="borderedProminent" onClick={() => setGeneration((value) => value + 1)}>
                  Try Again
                </Button>
              )}
            </>
          }
        />
      </EditorShell>
    );
  }
  if (!project || project.id !== projectId) {
    return (
      <EditorShell title="" onBack={() => navigate({ name: "projects" })} backLabel="Projects">
        <StageMessage spinner title="Opening…" />
      </EditorShell>
    );
  }
  const lab = getLab(project.labId);
  if (!lab) {
    return (
      <EditorShell title={project.title} onBack={() => navigate({ name: "projects" })} backLabel="Projects">
        <StageMessage
          icon={CircleAlert}
          title="This Lab Isn't Available"
          text={`“${project.title}” was made in a lab (“${project.labId}”) that this version of VISCERA doesn't include.`}
        />
      </EditorShell>
    );
  }
  return <ProjectEditor key={`${project.id}:${generation}`} initialProject={project} lab={lab} onReopen={() => setGeneration((value) => value + 1)} />;
}

function EditorShell({ title, onBack, backLabel, children }: { title: string; onBack: () => void; backLabel: string; children: ReactNode }) {
  return (
    <div className="px-editor">
      <ProjectBar backLabel={backLabel} onBack={onBack} title={<h1 className="px-pbar__title">{title}</h1>} />
      <div className="px-editor__body">{children}</div>
    </div>
  );
}

interface StageMessageProps {
  icon?: LucideIcon | undefined;
  spinner?: boolean | undefined;
  title: string;
  text?: string | undefined;
  actions?: ReactNode;
}

export function StageMessage({ icon, spinner = false, title, text, actions }: StageMessageProps) {
  return (
    <div className="px-stage-overlay" role={spinner ? "status" : undefined}>
      <div className="px-stage-overlay__card">
        {spinner ? <Spinner size={32} /> : icon ? <Icon icon={icon} size={32} /> : null}
        <p className="px-stage-overlay__title">{title}</p>
        {text ? <p className="px-stage-overlay__text">{text}</p> : null}
        {actions ? <div className="px-stage-overlay__actions">{actions}</div> : null}
      </div>
    </div>
  );
}

interface StageBannerProps {
  icon: LucideIcon;
  tone?: "neutral" | "warning" | "danger" | undefined;
  children: ReactNode;
  actions?: ReactNode;
}

export function StageBanner({ icon, tone = "neutral", children, actions }: StageBannerProps) {
  return (
    <div className="px-stage-banner" data-tone={tone} role="status">
      <Icon icon={icon} size={16} className="px-stage-banner__icon" />
      <span className="px-stage-banner__text">{children}</span>
      {actions ? <span className="px-stage-banner__actions">{actions}</span> : null}
    </div>
  );
}

function useSessionState(session: ProjectSession | null): SessionState | null {
  const subscribe = useCallback((listener: () => void) => (session ? session.subscribe(() => listener()) : () => undefined), [session]);
  const snapshot = useCallback(() => (session ? session.getState() : null), [session]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

type Phase = "connecting" | "opening" | "ready" | "failed";
type SheetName = "conflict" | "recover" | "review" | "named" | "copy";

interface ProjectEditorProps {
  initialProject: Project;
  lab: LabDefinition;
  onReopen: () => void;
}

function ProjectEditor({ initialProject, lab, onReopen }: ProjectEditorProps) {
  const backend = useBackend();
  const toast = useToast();
  const hud = useHud();
  const usage = useUsage();
  const usageRef = useRef(usage);
  usageRef.current = usage;
  const projectId = initialProject.id;

  const [handle, setHandle] = useState<LabHandle | null>(null);
  const [session, setSession] = useState<ProjectSession | null>(null);
  const [phase, setPhase] = useState<Phase>("connecting");
  const [failure, setFailure] = useState<string | null>(null);
  const [title, setTitle] = useState(initialProject.title);
  const [historyOpen, setHistoryOpenState] = useState(readHistoryOpen);
  const [renameRequest, setRenameRequest] = useState(0);
  const [restoreTarget, setRestoreTarget] = useState<ProjectVersion | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [requested, setRequested] = useState<SheetName | null>(null);
  const [dismissed, setDismissed] = useState<ReadonlySet<SheetName>>(new Set());
  const [conflictBusy, setConflictBusy] = useState<ConflictChoice | null>(null);
  const [recoverBusy, setRecoverBusy] = useState<"recover" | "discard" | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [leaveTarget, setLeaveTarget] = useState<(() => void) | null>(null);
  const state = useSessionState(session);
  const busy = useLabBusy(handle?.connection ?? null);
  const recorder = useLabRecorder(handle, lab.id, usage?.maxFileBytes ?? null);
  const src = useMemo(() => labUrl(lab, { restorePending: true }), [lab]);

  const setHistoryOpen = useCallback((open: boolean) => {
    setHistoryOpenState(open);
    writeHistoryOpen(open);
  }, []);

  // one session per connected lab frame; React may mount twice, so lifetimes are serialized per project
  useEffect(() => {
    if (!handle) return undefined;
    const turn = takeProjectTurn(projectId);
    let cancelled = false;
    setPhase("connecting");
    setFailure(null);
    const creation = (async (): Promise<ProjectSession | null> => {
      await turn.ready;
      if (cancelled) return null;
      const fresh = await backend.projects.get(projectId);
      if (cancelled) return null;
      const lock = createProjectLock(projectId);
      if (fresh.trashedAt === null) await acquireLockPatiently(lock);
      if (cancelled) {
        lock.release();
        return null;
      }
      return new ProjectSession({
        projects: backend.projects,
        snapshots: editorSnapshots(backend.assets, () => usageRef.current?.maxFileBytes ?? FALLBACK_MAX_FILE_BYTES),
        lab: handle.connection,
        project: fresh,
        reloadLab: labReloader(handle.connection, fresh.labId),
        lock,
        fingerprint: editorFingerprint,
      });
    })();
    creation.then(
      (created) => {
        if (!created || cancelled) return;
        setSession(created);
        setTitle(created.project.title);
        setPhase("opening");
        created.open().then(
          () => {
            if (!cancelled) setPhase("ready");
          },
          (reason: unknown) => {
            if (cancelled || isCancellation(reason)) return;
            setPhase("failed");
            setFailure(friendlyError(reason, "The lab couldn't show this project."));
          },
        );
      },
      (reason: unknown) => {
        if (cancelled) return;
        setPhase("failed");
        setFailure(friendlyError(reason, "This project couldn't be opened."));
      },
    );
    return () => {
      cancelled = true;
      setSession(null);
      turn.release(
        creation.then(
          async (created) => {
            if (!created) return;
            await created.flush({ close: true });
            created.dispose();
          },
          () => undefined,
        ),
      );
    };
  }, [handle, backend, projectId]);

  useEffect(() => {
    const previous = document.title;
    document.title = `${title} — VISCERA`;
    return () => {
      document.title = previous;
    };
  }, [title]);

  const pending = useCallback(() => {
    const current = session?.getState();
    return Boolean(current && (current.pending || current.status === "saving")) || recorder.phase !== "idle";
  }, [session, recorder.phase]);
  const flushNow = useMemo(() => (session ? () => void session.flush() : null), [session]);
  useLeavePrompt(pending);
  useFlushOnHide(flushNow);

  const readOnly = state?.status === "readonly";
  const writable = Boolean(session && state && !readOnly && !state.detached && state.status !== "conflict" && phase === "ready");
  const unsavedSinceHead = Boolean(state && (state.pending || state.hasDraft));

  /** Leaves the editor once pending changes are stored (or kept on this device); a recording asks first. */
  const leave = useCallback(
    (go: () => void) => {
      const proceed = () => {
        if (session) void session.flush().finally(go);
        else go();
      };
      if (recorder.phase !== "idle") setLeaveTarget(() => proceed);
      else proceed();
    },
    [session, recorder.phase],
  );

  const saveNow = useCallback(async () => {
    if (!session || !writable) {
      if (readOnly) toast.show({ message: "This project is read-only here.", tone: "info" });
      return;
    }
    try {
      const version = await session.commit("manual");
      hud({ label: version ? "Version Saved" : "No Changes to Save", icon: Check });
    } catch (reason) {
      if (!isCancellation(reason)) toast.show({ message: friendlyError(reason, "The version couldn't be saved."), tone: "error" });
    }
  }, [session, writable, readOnly, toast, hud]);

  const requestSheet = useCallback((sheet: SheetName) => {
    setRequested(sheet);
    setDismissed((current) => {
      if (!current.has(sheet)) return current;
      const next = new Set(current);
      next.delete(sheet);
      return next;
    });
  }, []);

  const openNamed = useCallback(() => {
    if (!writable) {
      if (readOnly) toast.show({ message: "This project is read-only here.", tone: "info" });
      return;
    }
    requestSheet("named");
  }, [writable, readOnly, toast, requestSheet]);

  const openSaveCopy = useCallback(() => {
    if (!session || phase !== "ready") return;
    requestSheet("copy");
  }, [session, phase, requestSheet]);

  const toggleHistory = useCallback(() => setHistoryOpen(!historyOpen), [historyOpen, setHistoryOpen]);

  useShortcuts([
    { keys: "mod+s", allowInEditable: true, handler: () => void saveNow() },
    { keys: "shift+mod+s", allowInEditable: true, handler: openNamed },
    { keys: "alt+shift+mod+s", allowInEditable: true, handler: openSaveCopy },
    { keys: "alt+mod+y", handler: toggleHistory },
  ]);

  const onNavigate = useCallback(
    (request: LabNavigationRequest) => {
      if (request.labId && request.labId !== lab.id && (request.reason === "lab" || request.reason === "top")) {
        const target = request.labId;
        leave(() => navigate({ name: "lab", labId: target }));
        return;
      }
      if (request.reason === "same-lab" || request.labId === lab.id) {
        toast.show({ message: "That link would reload the lab, so it isn't available inside a project.", tone: "info" });
        return;
      }
      window.open(request.url, "_blank", "noopener,noreferrer");
    },
    [lab.id, leave, toast],
  );

  const handlers = useMemo<LabFrameHandlers>(
    () => ({
      onSave: () => void saveNow(),
      onSaveNamed: openNamed,
      onNavigate,
      onFlush: () => flushNow?.(),
      shortcuts: { "version-history": toggleHistory, "save-copy": openSaveCopy },
    }),
    [saveNow, openNamed, onNavigate, flushNow, toggleHistory, openSaveCopy],
  );

  const rename = useCallback(
    async (next: string) => {
      try {
        const updated = await backend.projects.update(projectId, { title: next });
        setTitle(updated.title);
        invalidate("projects");
      } catch (reason) {
        toast.show({ message: friendlyError(reason, "The project couldn't be renamed."), tone: "error" });
        throw reason;
      }
    },
    [backend, projectId, toast],
  );

  const runRestore = async (version: ProjectVersion) => {
    if (!session) return;
    setRestoring(true);
    try {
      const restored = await session.restore(version.id);
      invalidate(versionsKey(projectId));
      invalidate("projects");
      const previous = restored.parentVersionId;
      toast.show({
        message: `Restored “${versionTitle(version)}”.`,
        tone: "success",
        action: previous
          ? {
              label: "Undo",
              onAction: () => {
                void session.restore(previous).catch((reason: unknown) => {
                  if (!isCancellation(reason)) toast.show({ message: friendlyError(reason, "Couldn't undo the restore."), tone: "error" });
                });
              },
            }
          : undefined,
      });
    } catch (reason) {
      if (!isCancellation(reason)) toast.show({ message: friendlyError(reason, "The version couldn't be restored."), tone: "error" });
    } finally {
      setRestoreTarget(null);
      setRestoring(false);
    }
  };

  const openAsCopy = async (version: ProjectVersion) => {
    try {
      const copy = await backend.projects.duplicate(projectId, copyTitle(`${title} (${versionTitle(version)})`), version.id);
      invalidate("projects");
      toast.show({ message: `Opened “${copy.title}”, a copy of ${versionTitle(version)}.`, tone: "success" });
      leave(() => navigate({ name: "project", id: copy.id }));
    } catch (reason) {
      toast.show({ message: friendlyError(reason, "The copy couldn't be made."), tone: "error" });
    }
  };

  const duplicate = async () => {
    try {
      if (session) await session.flush();
      const copy = await backend.projects.duplicate(projectId, copyTitle(title));
      invalidate("projects");
      toast.show({
        message: `Duplicated as “${copy.title}”.`,
        tone: "success",
        action: { label: "Open", onAction: () => leave(() => navigate({ name: "project", id: copy.id })) },
      });
    } catch (reason) {
      toast.show({ message: friendlyError(reason, "The project couldn't be duplicated."), tone: "error" });
    }
  };

  const moveToTrash = async () => {
    try {
      if (session) await session.flush();
      await backend.projects.update(projectId, { trashed: true });
      invalidate("projects");
      invalidate("trash");
      const name = title;
      navigate({ name: "projects" });
      toast.show({
        message: `Moved “${name}” to the Trash.`,
        tone: "info",
        action: {
          label: "Undo",
          onAction: () => {
            void backend.projects.update(projectId, { trashed: false }).then(
              () => {
                invalidate("projects");
                invalidate("trash");
              },
              (reason: unknown) => toast.show({ message: friendlyError(reason, "Couldn't put the project back."), tone: "error" }),
            );
          },
        },
      });
    } catch (reason) {
      toast.show({ message: friendlyError(reason, "The project couldn't be moved to the Trash."), tone: "error" });
    }
  };

  const chooseConflict = async (choice: ConflictChoice) => {
    if (!session) return;
    setConflictBusy(choice);
    try {
      if (choice === "reload") {
        await session.reloadRemote();
        toast.show({ message: "Showing the newest saved state.", tone: "info" });
      } else if (choice === "overwrite") {
        await session.overwrite();
        toast.show({ message: "Your version is current. Theirs is in Version History.", tone: "success" });
      } else {
        const copy = await session.saveAsCopy(copyTitle(title));
        invalidate("projects");
        toast.show({ message: `Saved your version as “${copy.title}”.`, tone: "success" });
        navigate({ name: "project", id: copy.id });
      }
      invalidate(versionsKey(projectId));
    } catch (reason) {
      if (!isCancellation(reason)) toast.show({ message: friendlyError(reason, "That didn't work. Try again."), tone: "error" });
    } finally {
      setConflictBusy(null);
    }
  };

  const recover = async (choice: "recover" | "discard") => {
    if (!session) return;
    setRecoverBusy(choice);
    try {
      if (choice === "recover") {
        await session.recoverUnsaved();
        toast.show({ message: "Recovered your unsaved changes.", tone: "success" });
      } else {
        await session.discardUnsaved();
      }
    } catch (reason) {
      if (!isCancellation(reason)) toast.show({ message: friendlyError(reason, "The changes couldn't be recovered."), tone: "error" });
    } finally {
      setRecoverBusy(null);
    }
  };

  const continueAfterReview = async () => {
    if (!session) return;
    setReviewBusy(true);
    try {
      await session.acknowledgeRestore();
    } catch (reason) {
      toast.show({ message: friendlyError(reason, "Autosave couldn't resume."), tone: "error" });
    } finally {
      setReviewBusy(false);
    }
  };

  const statusAction = async (action: Exclude<EditorStatusAction, null>) => {
    if (!session) return;
    try {
      switch (action) {
        case "edit-here":
          await session.editHere();
          break;
        case "retry":
          await session.retry();
          break;
        case "resolve":
          requestSheet("conflict");
          break;
        case "reload-lab":
          await session.open();
          break;
        case "review-restore":
          requestSheet("review");
          break;
        case "put-back":
          await backend.projects.update(projectId, { trashed: false });
          invalidate("projects");
          invalidate("trash");
          onReopen();
          break;
      }
    } catch (reason) {
      if (!isCancellation(reason)) toast.show({ message: friendlyError(reason), tone: "error" });
    }
  };

  // one sheet at a time (HIG): what the session needs decided first, then what the person asked for
  const wants = (name: SheetName) => !dismissed.has(name);
  let sheet: SheetName | null = null;
  if (state?.status === "conflict" && wants("conflict")) sheet = "conflict";
  else if (state?.recoverable && phase === "ready" && !readOnly && wants("recover")) sheet = "recover";
  else if (state?.acknowledgementNeeded && wants("review")) sheet = "review";
  else if (requested === "named" || requested === "copy") sheet = requested;
  const dismiss = (name: SheetName) => {
    setDismissed((current) => new Set(current).add(name));
    if (requested === name) setRequested(null);
  };

  const source: LibrarySource = {
    labId: lab.id,
    labTitle: lab.title,
    projectId,
    versionId: state && !unsavedSinceHead ? state.headVersionId : null,
    unsavedChanges: unsavedSinceHead,
  };

  const subtitle = (
    <>
      <span className="px-pbar__lab">{lab.title}</span>
      <span className="px-pbar__dot" aria-hidden="true">
        ·
      </span>
      {state ? (
        <SaveStatus state={state} onAction={(action) => void statusAction(action)} />
      ) : (
        <span className="px-pbar-status">{phase === "failed" ? "Not open" : "Opening…"}</span>
      )}
    </>
  );

  const menu = (
    <>
      <MenuItem icon={Save} shortcut="mod+s" disabled={!writable} onSelect={() => void saveNow()}>
        Save Version Now
      </MenuItem>
      <MenuItem icon={BookmarkPlus} shortcut="shift+mod+s" disabled={!writable} onSelect={openNamed}>
        Save Version As…
      </MenuItem>
      <MenuItem icon={CopyPlus} shortcut="alt+shift+mod+s" disabled={!session || phase !== "ready"} onSelect={openSaveCopy}>
        Save a Copy…
      </MenuItem>
      <MenuItem icon={History} shortcut="alt+mod+y" checked={historyOpen} onSelect={toggleHistory}>
        Version History
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon={PencilLine} disabled={state?.readonlyReason === "trashed"} onSelect={() => setRenameRequest((value) => value + 1)}>
        Rename…
      </MenuItem>
      <MenuItem icon={CopyPlus} onSelect={() => void duplicate()}>
        Duplicate
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon={Trash2} destructive disabled={state?.readonlyReason === "trashed"} onSelect={() => void moveToTrash()}>
        Move to Trash
      </MenuItem>
    </>
  );

  let banner: ReactNode = null;
  if (phase === "ready" && state?.detached) {
    banner = (
      <StageBanner
        icon={TriangleAlert}
        tone="warning"
        actions={
          <Button size="regular" variant="borderedProminent" onClick={() => void statusAction("reload-lab")}>
            Reload Lab
          </Button>
        }
      >
        The lab reloaded on its own, so changes made in it now are not saved to this project.
      </StageBanner>
    );
  } else if (phase === "ready" && state?.readonlyReason === "locked") {
    banner = (
      <StageBanner
        icon={Lock}
        tone="warning"
        actions={
          <Button size="regular" variant="borderedProminent" onClick={() => void statusAction("edit-here")}>
            Edit Here
          </Button>
        }
      >
        This project is open for editing in another tab. Changes made here are not saved.
      </StageBanner>
    );
  } else if (phase === "ready" && state?.readonlyReason === "trashed") {
    banner = (
      <StageBanner
        icon={Trash2}
        tone="warning"
        actions={
          <Button size="regular" variant="borderedProminent" onClick={() => void statusAction("put-back")}>
            Put Back
          </Button>
        }
      >
        This project is in the Trash. Put it back to edit it.
      </StageBanner>
    );
  } else if (phase === "ready" && state?.recoverable && sheet !== "recover" && !readOnly) {
    banner = (
      <StageBanner
        icon={History}
        actions={
          <Button size="regular" onClick={() => requestSheet("recover")}>
            Review…
          </Button>
        }
      >
        Unsaved changes from this device can be recovered.
      </StageBanner>
    );
  }

  return (
    <div className="px-editor" data-phase={phase}>
      <ProjectBar
        backLabel="Projects"
        onBack={() => leave(() => navigate({ name: "projects" }))}
        title={<EditableTitle value={title} onRename={rename} editRequest={renameRequest} disabled={state?.readonlyReason === "trashed"} />}
        subtitle={subtitle}
        trailing={
          <>
            <RecordButton
              recorder={recorder}
              busy={recorder.phase === "idle" ? busy : false}
              disabled={phase !== "ready"}
              onError={(message) => toast.show({ message, tone: "warning" })}
            />
            <span className="px-pbar__hide-narrow">
              <AddToLibraryMenu handle={handle} source={source} baseTitle={title} busy={busy} disabled={phase !== "ready"} />
            </span>
            <IconButton
              icon={History}
              label={historyOpen ? "Hide Version History" : "Show Version History"}
              shortcut="alt+mod+y"
              size="large"
              pressed={historyOpen}
              onClick={toggleHistory}
            />
            <IconMenuButton label="More" menu={menu} />
          </>
        }
      />
      <div className="px-editor__body">
        <section className="px-editor__stage" aria-label={`${lab.title} lab`}>
          <LabFrame src={src} labId={lab.id} title={`${lab.title}: ${title}`} onConnect={setHandle} handlers={handlers}>
            {phase === "connecting" || phase === "opening" ? <StageMessage spinner title={`Opening “${title}”…`} /> : null}
            {phase === "failed" ? (
              <StageMessage
                icon={CircleAlert}
                title="Couldn't Show This Project"
                text={failure ?? undefined}
                actions={
                  <>
                    <Button size="large" onClick={() => navigate({ name: "projects" })}>
                      Show Projects
                    </Button>
                    <Button size="large" variant="borderedProminent" onClick={onReopen}>
                      Try Again
                    </Button>
                  </>
                }
              />
            ) : null}
          </LabFrame>
          {banner}
        </section>
        {historyOpen ? (
          <VersionHistoryPanel
            projectId={projectId}
            headVersionId={state?.headVersionId ?? initialProject.headVersionId}
            headSeq={state?.headSeq ?? initialProject.headSeq}
            editedSinceHead={unsavedSinceHead}
            readOnly={!writable}
            busy={busy}
            retentionDays={usage?.versionRetentionDays ?? null}
            onClose={() => setHistoryOpen(false)}
            onRestore={(version) => setRestoreTarget(version)}
            onOpenCopy={(version) => void openAsCopy(version)}
          />
        ) : null}
      </div>

      <ConflictSheet
        open={sheet === "conflict"}
        projectTitle={title}
        kind={state?.conflict?.kind ?? "version"}
        busy={conflictBusy}
        onChoose={(choice) => void chooseConflict(choice)}
        onClose={() => dismiss("conflict")}
      />
      <RecoverSheet
        open={sheet === "recover"}
        projectTitle={title}
        savedAt={state?.recoverable?.savedAt ?? new Date().toISOString()}
        stale={state?.recoverable?.stale ?? false}
        busy={recoverBusy}
        onRecover={() => void recover("recover")}
        onDiscard={() => void recover("discard")}
        onClose={() => dismiss("recover")}
      />
      <RestoreReviewSheet
        open={sheet === "review"}
        warnings={state?.lastRestore?.warnings ?? []}
        busy={reviewBusy}
        onContinue={() => void continueAfterReview()}
        onShowHistory={() => {
          dismiss("review");
          setHistoryOpen(true);
        }}
      />
      <NameSheet
        open={sheet === "named"}
        onClose={() => setRequested(null)}
        title="Save Version"
        description="Named versions are kept until you remove their name."
        initialValue={nextVersionName(state?.headSeq ?? initialProject.headSeq)}
        submitLabel="Save Version"
        failure="The version couldn't be saved."
        onSubmit={async (name) => {
          if (!session) return;
          await session.commit("named", name);
          hud({ label: "Version Saved", icon: Check });
        }}
      />
      <NameSheet
        open={sheet === "copy"}
        onClose={() => setRequested(null)}
        title="Save a Copy"
        description="The copy is a new project with what the lab shows now. This project stays as it is."
        initialValue={copyTitle(title)}
        submitLabel="Save Copy"
        failure="The copy couldn't be saved."
        onSubmit={async (name) => {
          if (!session) return;
          const copy = await session.saveAsCopy(name);
          invalidate("projects");
          toast.show({ message: `Saved “${copy.title}”.`, tone: "success" });
          navigate({ name: "project", id: copy.id });
        }}
      />
      <Alert
        open={restoreTarget !== null}
        onClose={() => {
          if (!restoring) setRestoreTarget(null);
        }}
        icon={<Icon icon={History} size={40} />}
        title={`Restore “${restoreTarget ? versionTitle(restoreTarget) : ""}”?`}
        message={
          busy
            ? `The lab is busy (${busy}). The restore starts when it has finished.`
            : "What the lab shows now is kept in Version History first, so you can go back to it."
        }
        actionLabel={restoring ? "Restoring…" : "Restore"}
        onAction={() => {
          if (restoreTarget && !restoring) void runRestore(restoreTarget);
        }}
      />
      <Alert
        open={leaveTarget !== null}
        onClose={() => setLeaveTarget(null)}
        title={recorder.phase === "review" ? "Leave Without Saving the Recording?" : "Stop Recording and Leave?"}
        message="The recording will be discarded."
        actionLabel="Leave"
        destructive
        onAction={() => {
          const go = leaveTarget;
          setLeaveTarget(null);
          recorder.discard();
          go?.();
        }}
      />
      <RecordSheet recorder={recorder} source={source} baseTitle={title} />
    </div>
  );
}
