import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cx } from "../lib/dom";
import { describeChord, formatChord, parseShortcut, type ShortcutSpec } from "../lib/shortcuts";
import { useIsMac } from "../hooks/usePlatform";
import { Icon } from "./Icon";
import "./display.css";

export interface EmptyStateProps {
  icon?: LucideIcon | undefined;
  /** Says what is missing ("No Items Yet"). */
  title: ReactNode;
  /** Says what to do ("Shapes, materials and recordings you save from a lab appear here."). */
  description?: ReactNode;
  /** A bordered button, or a prominent one when it is the only way forward. */
  action?: ReactNode;
  headingLevel?: 2 | 3 | undefined;
  className?: string | undefined;
}

/** Centred, shifted up 8 %, at most 360 wide (§2.15). */
export function EmptyState({ icon, title, description, action, headingLevel = 2, className }: EmptyStateProps) {
  const Heading = headingLevel === 3 ? "h3" : "h2";
  return (
    <div className={cx("px-empty", className)}>
      {icon ? <Icon icon={icon} size={44} className="px-empty__icon" /> : null}
      <Heading className="px-empty__title">{title}</Heading>
      {description ? <p className="px-empty__description">{description}</p> : null}
      {action ? <div className="px-empty__action">{action}</div> : null}
    </div>
  );
}

export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger" | "hud";

export interface BadgeProps {
  tone?: BadgeTone | undefined;
  icon?: LucideIcon | undefined;
  children: ReactNode;
  className?: string | undefined;
}

/** Caption 2 chips ("4K · PBR", "Pro", "Named"); "hud" is the white-on-dark chip used over thumbnails. */
export function Badge({ tone = "neutral", icon, children, className }: BadgeProps) {
  return (
    <span className={cx("px-badge", `px-badge--${tone}`, className)}>
      {icon ? <Icon icon={icon} size={10} strokeWidth={2} /> : null}
      <span className="px-badge__label">{children}</span>
    </span>
  );
}

export interface KeyboardShortcutProps {
  keys: ShortcutSpec;
  className?: string | undefined;
}

/** "⌥⌘Y" on Apple platforms, "Ctrl+Alt+Y" elsewhere; screen readers hear the words ("Option Command Y"). */
export function KeyboardShortcut({ keys, className }: KeyboardShortcutProps) {
  const mac = useIsMac();
  const chord = parseShortcut(keys, mac);
  return (
    <span className={cx("px-kbd", className)}>
      <kbd aria-hidden="true">{formatChord(chord, mac)}</kbd>
      <span className="px-visually-hidden">{describeChord(chord, mac)}</span>
    </span>
  );
}
