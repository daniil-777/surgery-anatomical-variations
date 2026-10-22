// Tags of an imported object: accent chips with a remove button, and a field that adds what is typed on Return, comma
// or leaving the field (APPLE_STYLE_SPEC §3.4 "Tags (token field)"). At most 20 tags of 32 characters, as the database
// allows; anything over that is refused with a short note under the field.

import { useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { Icon, TextField } from "../../ui";
import { addTags, MAX_TAG_LENGTH, MAX_TAGS, removeTag } from "./model";

export interface TagEditorProps {
  tags: readonly string[];
  /** Called with the full new list; the owner saves it. */
  onChange: (tags: string[]) => void;
  /** Names the field ("Add a tag to Chair"). */
  itemName: string;
}

export function TagEditor({ tags, onChange, itemName }: TagEditorProps) {
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState<string | null>(null);

  const commit = () => {
    if (draft.trim() === "") return;
    const { tags: next, rejected } = addTags(tags, draft);
    setDraft("");
    setNote(
      rejected.length === 0
        ? null
        : next.length >= MAX_TAGS
          ? `An import can have up to ${MAX_TAGS} tags.`
          : `Tags can be up to ${MAX_TAG_LENGTH} characters long.`,
    );
    if (next.length !== tags.length) onChange(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      commit();
    } else if (event.key === "Backspace" && draft === "" && tags.length > 0) {
      // Backspace in an empty token field removes the last token, as in Mail and Finder
      event.preventDefault();
      const last = tags[tags.length - 1];
      if (last !== undefined) onChange(removeTag(tags, last));
    }
  };

  return (
    <div className="px-imports-tags">
      {tags.length > 0 ? (
        <ul role="list" className="px-imports-tags__list" aria-label="Tags">
          {tags.map((tag) => (
            <li key={tag} className="px-imports-tag">
              <span>{tag}</span>
              <button type="button" className="px-imports-tag__remove" aria-label={`Remove Tag “${tag}”`} onClick={() => onChange(removeTag(tags, tag))}>
                <Icon icon={X} size={10} strokeWidth={2.25} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-imports-tags__empty">No tags yet.</p>
      )}
      <TextField
        label={`Add a tag to ${itemName}`}
        hideLabel
        size="regular"
        placeholder={tags.length >= MAX_TAGS ? "Tag limit reached" : "Add Tag"}
        value={draft}
        disabled={tags.length >= MAX_TAGS}
        maxLength={MAX_TAG_LENGTH * 4}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={commit}
        hint={note}
        enterKeyHint="done"
        autoComplete="off"
        spellCheck={false}
      />
    </div>
  );
}
