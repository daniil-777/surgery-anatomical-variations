// After an inexact restore (the lab reported exact: false) autosave waits until the person has seen what differs
// (DESIGN.md §15.6). The lab's own sentences are shown verbatim; the source version is kept under a name.

import { Button, Sheet } from "../../ui";

export interface RestoreReviewSheetProps {
  open: boolean;
  /** The lab's warnings, copied verbatim. */
  warnings: readonly string[];
  busy: boolean;
  onContinue: () => void;
  onShowHistory: () => void;
}

export function RestoreReviewSheet({ open, warnings, busy, onContinue, onShowHistory }: RestoreReviewSheetProps) {
  return (
    <Sheet
      open={open}
      onClose={onContinue}
      title="Restored With Differences"
      description="The lab could not show this version exactly as it was saved."
      size="small"
      leadingActions={
        <Button size="large" variant="plain" onClick={onShowHistory}>
          Version History
        </Button>
      }
      actions={
        <Button size="large" variant="borderedProminent" onClick={onContinue} loading={busy} loadingLabel="Continuing…">
          Continue Editing
        </Button>
      }
    >
      {warnings.length > 0 ? (
        <ul className="px-warning-list">
          {warnings.map((warning, index) => (
            <li key={index}>{warning}</li>
          ))}
        </ul>
      ) : (
        <p className="px-sheet-note">The lab did not say what differs.</p>
      )}
      <p className="px-sheet-note">
        Autosave is paused until you continue. The saved version stays in Version History under a name, so it is never removed.
      </p>
    </Sheet>
  );
}
