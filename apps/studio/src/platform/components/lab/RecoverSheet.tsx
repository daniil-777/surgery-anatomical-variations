// Unsaved changes this device journalled (IndexedDB) that never reached the account — a closed tab, a crash, a lost
// connection (DESIGN.md §15.5). Recovering shows them in the lab and saves them; discarding forgets them.

import { Button, Sheet } from "../../ui";
import { formatSavedAt } from "./versionHistory";

export interface RecoverSheetProps {
  open: boolean;
  projectTitle: string;
  /** When the changes were written on this device. */
  savedAt: string;
  /** The project changed elsewhere since: its newer state is kept as a version before recovering. */
  stale: boolean;
  busy: "recover" | "discard" | null;
  onRecover: () => void;
  onDiscard: () => void;
  /** Decide later (a banner keeps the offer). */
  onClose: () => void;
}

export function RecoverSheet({ open, projectTitle, savedAt, stale, busy, onRecover, onDiscard, onClose }: RecoverSheetProps) {
  const when = formatSavedAt(savedAt, new Date());
  return (
    <Sheet
      open={open}
      onClose={() => {
        if (busy === null) onClose();
      }}
      title="Recover Unsaved Changes?"
      description={`This device kept changes to “${projectTitle}”${when ? ` from ${when.charAt(0).toLowerCase()}${when.slice(1)}` : ""} that didn't reach your account.`}
      size="small"
      leadingActions={
        <Button size="large" variant="plain" onClick={onClose} aria-disabled={busy !== null || undefined}>
          Decide Later
        </Button>
      }
      actions={
        <>
          <Button size="large" variant="destructive" onClick={onDiscard} loading={busy === "discard"} aria-disabled={(busy !== null && busy !== "discard") || undefined}>
            Discard
          </Button>
          <Button size="large" variant="borderedProminent" onClick={onRecover} loading={busy === "recover"} loadingLabel="Recovering…" aria-disabled={(busy !== null && busy !== "recover") || undefined}>
            Recover
          </Button>
        </>
      }
    >
      <p className="px-sheet-note">
        {stale
          ? "The project has changed since then. Its newer state is kept in Version History before your changes are shown and saved."
          : "Recovering shows these changes in the lab and saves them to your account. Discarding removes them from this device."}
      </p>
    </Sheet>
  );
}
