// Another tab or device saved this project while this tab was editing (409 version_conflict / draft_conflict). Nothing
// is overwritten silently (DESIGN.md D8): the person picks whose work stays current, and the other side's work is kept
// in Version History or as a copy.

import { Button, Sheet } from "../../ui";

export type ConflictChoice = "reload" | "overwrite" | "copy";

export interface ConflictSheetProps {
  open: boolean;
  projectTitle: string;
  /** "draft": they saved their working copy; "version": they saved a version. */
  kind: "version" | "draft";
  /** The choice in progress (its button shows a spinner, the others wait). */
  busy: ConflictChoice | null;
  onChoose: (choice: ConflictChoice) => void;
  /** Decide later: the status line keeps a "Resolve…" button. */
  onClose: () => void;
}

export function ConflictSheet({ open, projectTitle, kind, busy, onChoose, onClose }: ConflictSheetProps) {
  const disabled = busy !== null || undefined;
  const what = kind === "draft" ? "changes" : "a new version";
  return (
    <Sheet
      open={open}
      onClose={() => {
        if (busy === null) onClose();
      }}
      title="This Project Changed Elsewhere"
      description={`Another tab or device saved ${what} of “${projectTitle}” while you were editing here.`}
      size="medium"
      leadingActions={
        <Button size="large" onClick={() => onChoose("copy")} loading={busy === "copy"} loadingLabel="Saving Copy…" aria-disabled={disabled && busy !== "copy"}>
          Save Mine as a Copy
        </Button>
      }
      actions={
        <>
          <Button size="large" onClick={() => onChoose("reload")} loading={busy === "reload"} loadingLabel="Reloading…" aria-disabled={disabled && busy !== "reload"}>
            Use Theirs
          </Button>
          <Button
            size="large"
            variant="borderedProminent"
            onClick={() => onChoose("overwrite")}
            loading={busy === "overwrite"}
            loadingLabel="Saving…"
            aria-disabled={disabled && busy !== "overwrite"}
          >
            Keep Mine
          </Button>
        </>
      }
    >
      <dl className="px-choice-list">
        <div className="px-choice-list__item">
          <dt>Keep Mine</dt>
          <dd>What this tab shows becomes the current state. Their work is kept in Version History first.</dd>
        </div>
        <div className="px-choice-list__item">
          <dt>Use Theirs</dt>
          <dd>Shows the newest saved state here. Changes made in this tab that were not saved yet are discarded.</dd>
        </div>
        <div className="px-choice-list__item">
          <dt>Save Mine as a Copy</dt>
          <dd>Saves what this tab shows as a new project and opens it. This project keeps their work.</dd>
        </div>
      </dl>
    </Sheet>
  );
}
