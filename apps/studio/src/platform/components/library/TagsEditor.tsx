// A token field for an item's tags (APPLE_STYLE_SPEC §3.4 "Tags (token field)"): each tag is a capsule with its own
// remove button; typing and Return (or a comma) adds one, Backspace in the empty field selects the last tag and a
// second Backspace removes it. Every change is saved at once by the owner (optimistically, like Finder tags).
import { useId, useImperativeHandle, useRef, useState, type KeyboardEvent, type Ref } from "react";
import { CircleAlert, X } from "lucide-react";
import { cx, Icon } from "../../ui";
import { tagProblem } from "./messages";
import "./library.css";

export interface TagsEditorProps {
  tags: readonly string[];
  onChange: (tags: string[]) => void;
  /** The visible label above the field ("Tags"). */
  label?: string | undefined;
  disabled?: boolean | undefined;
  /** focus() puts the caret in the field ("Edit Tags…" in menus). */
  ref?: Ref<TagsEditorHandle> | undefined;
}

export interface TagsEditorHandle {
  focus(): void;
}

export function TagsEditor({ tags, onChange, label = "Tags", disabled = false, ref }: TagsEditorProps) {
  const inputId = useId();
  const errorId = useId();
  const input = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [armed, setArmed] = useState<number | null>(null);

  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus() }), []);

  const add = (text: string): boolean => {
    const tag = text.trim();
    if (tag === "") return true;
    const issue = tagProblem(tag, tags);
    setProblem(issue);
    if (issue) return false;
    onChange([...tags, tag]);
    return true;
  };

  const remove = (index: number) => {
    onChange(tags.filter((_, position) => position !== index));
    setArmed(null);
    setProblem(null);
    input.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      if (add(draft)) setDraft("");
      return;
    }
    if (event.key === "Backspace" && draft === "" && tags.length > 0) {
      event.preventDefault();
      if (armed === tags.length - 1) remove(tags.length - 1);
      else setArmed(tags.length - 1);
      return;
    }
    if (event.key === "Escape" && (draft !== "" || problem)) {
      event.preventDefault();
      event.stopPropagation();
      setDraft("");
      setProblem(null);
      return;
    }
    setArmed(null);
  };

  return (
    <div className={cx("px-tags", problem && "px-tags--invalid", disabled && "px-tags--disabled")}>
      <label htmlFor={inputId} className="px-tags__label">
        {label}
      </label>
      <div className="px-tags__field" onClick={() => input.current?.focus()}>
        {tags.length > 0 ? (
          <ul role="list" className="px-tags__list" aria-label={label}>
            {tags.map((tag, index) => (
              <li key={tag} className={cx("px-tag", armed === index && "px-tag--armed")}>
                <span className="px-tag__text">{tag}</span>
                <button
                  type="button"
                  className="px-tag__remove"
                  aria-label={`Remove Tag “${tag}”`}
                  disabled={disabled}
                  onClick={(event) => {
                    event.stopPropagation();
                    remove(index);
                  }}
                >
                  <Icon icon={X} size={9} strokeWidth={2.5} />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <input
          ref={input}
          id={inputId}
          className="px-tags__input"
          value={draft}
          disabled={disabled}
          placeholder={tags.length === 0 ? "Add Tags" : "Add Tag"}
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="done"
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? errorId : undefined}
          onChange={(event) => {
            setDraft(event.target.value);
            setArmed(null);
            if (problem) setProblem(null);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => {
            setArmed(null);
            if (add(draft)) setDraft("");
          }}
        />
      </div>
      {problem ? (
        <p id={errorId} className="px-tags__message" role="alert">
          <Icon icon={CircleAlert} size={12} />
          <span>{problem}</span>
        </p>
      ) : null}
    </div>
  );
}
