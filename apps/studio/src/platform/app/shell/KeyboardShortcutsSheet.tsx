// "Keyboard Shortcuts" (⌘/): the shell's own shortcuts. Lists only keys this window handles; pages and the project
// editor show theirs in their own menus and tooltips.

import { Button, KeyboardShortcut, Sheet, SIDEBAR_SHORTCUT, type ShortcutSpec } from "../../ui";
import "./styles/shell.css";

interface ShortcutRow {
  label: string;
  keys: ShortcutSpec;
}

const GROUPS: ReadonlyArray<{ title: string; rows: readonly ShortcutRow[] }> = [
  {
    title: "Window",
    rows: [
      { label: "Show or Hide the Sidebar", keys: SIDEBAR_SHORTCUT },
      { label: "Account Settings", keys: "mod+," },
      { label: "Keyboard Shortcuts", keys: "mod+/" },
    ],
  },
  {
    title: "Menus, Lists and Sheets",
    rows: [
      { label: "Move Between Items", keys: "arrowdown" },
      { label: "Choose the Highlighted Item", keys: "enter" },
      { label: "Close a Menu, Popover or Sheet", keys: "escape" },
    ],
  },
];

export function KeyboardShortcutsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Keyboard Shortcuts"
      size="small"
      grouped
      actions={
        <Button variant="borderedProminent" onClick={onClose}>
          Done
        </Button>
      }
    >
      {GROUPS.map((group) => (
        <section key={group.title} className="px-shell-shortcuts" aria-label={group.title}>
          <h3 className="px-shell-shortcuts__title">{group.title}</h3>
          <dl className="px-shell-shortcuts__list">
            {group.rows.map((row) => (
              <div key={row.label} className="px-shell-shortcuts__row">
                <dt>{row.label}</dt>
                <dd>
                  <KeyboardShortcut keys={row.keys} />
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </Sheet>
  );
}
