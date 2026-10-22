// The two sheets of the Imports space: Rename, and Change Source (a person's correction of the detected application,
// stored as "set by you"; the file itself never changes). Sheets are small, Return confirms, Escape cancels (§2.11).

import { useEffect, useId, useState, type FormEvent } from "react";
import type { ImportedObject, SourceApp } from "../../core/types";
import { Button, Select, Sheet, TextField } from "../../ui";
import { detectionSummary, SOURCE_APP_ORDER, SOURCE_LABEL } from "./model";

const MAX_TITLE = 120;

export interface RenameSheetProps {
  object: ImportedObject | null;
  onClose: () => void;
  onRename: (object: ImportedObject, title: string) => void;
}

export function RenameSheet({ object, onClose, onRename }: RenameSheetProps) {
  const formId = useId();
  const [title, setTitle] = useState("");
  useEffect(() => {
    if (object) setTitle(object.title);
  }, [object]);
  const trimmed = title.trim();
  const tooLong = [...trimmed].length > MAX_TITLE;
  const unchanged = object !== null && trimmed === object.title;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!object || trimmed === "" || tooLong) return;
    if (!unchanged) onRename(object, trimmed);
    onClose();
  };
  return (
    <Sheet
      open={object !== null}
      onClose={onClose}
      title="Rename Import"
      size="small"
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form={formId} variant="borderedProminent" aria-disabled={trimmed === "" || tooLong}>
            Rename
          </Button>
        </>
      }
    >
      <form id={formId} className="px-imports-sheet__body" onSubmit={submit}>
        <TextField
          label="Name"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          error={tooLong ? `Use at most ${MAX_TITLE} characters.` : trimmed === "" ? "Enter a name." : undefined}
          autoComplete="off"
          spellCheck={false}
        />
      </form>
    </Sheet>
  );
}

export interface SourceSheetProps {
  object: ImportedObject | null;
  onClose: () => void;
  onChange: (object: ImportedObject, sourceApp: SourceApp) => void;
}

export function SourceSheet({ object, onClose, onChange }: SourceSheetProps) {
  const formId = useId();
  const selectId = useId();
  const [app, setApp] = useState<SourceApp>("unknown");
  useEffect(() => {
    if (object) setApp(object.sourceApp);
  }, [object]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!object) return;
    if (app !== object.sourceApp || object.detectedBy !== "user") onChange(object, app);
    onClose();
  };
  return (
    <Sheet
      open={object !== null}
      onClose={onClose}
      title="Change Source"
      description={object ? `Which app made “${object.title}”?` : undefined}
      size="small"
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form={formId} variant="borderedProminent">
            Change Source
          </Button>
        </>
      }
    >
      <form id={formId} className="px-imports-sheet__body" onSubmit={submit}>
        <div className="px-imports-sheet__field">
          <label htmlFor={selectId} className="px-imports-sheet__label">
            Application
          </label>
          <Select
            id={selectId}
            controlSize="large"
            value={app}
            onChange={(event) => setApp(SOURCE_APP_ORDER.find((candidate) => candidate === event.target.value) ?? "unknown")}
          >
            {SOURCE_APP_ORDER.map((candidate) => (
              <option key={candidate} value={candidate}>
                {SOURCE_LABEL[candidate]}
              </option>
            ))}
          </Select>
        </div>
        {object ? <p className="px-imports-sheet__note">{detectionSummary(object)}</p> : null}
        <p className="px-imports-sheet__note">Your choice is saved with the import and shown as set by you. The file itself is not changed.</p>
      </form>
    </Sheet>
  );
}
