import { useId } from "react";
import type { LucideIcon, LucideProps } from "lucide-react";
import { cx } from "../lib/dom";
import { iconStrokeWidth } from "../lib/format";

export type IconComponent = LucideIcon;

export interface IconProps extends Omit<LucideProps, "ref" | "size"> {
  icon: LucideIcon;
  /** Pixel size; the stroke follows §0.8 (1.75 at text sizes, 1.5 from 20 px). */
  size?: number | undefined;
}

/** Decorative lucide glyph (the control around it carries the accessible name). */
export function Icon({ icon: Glyph, size = 16, strokeWidth, className, ...rest }: IconProps) {
  return (
    <Glyph
      aria-hidden="true"
      focusable="false"
      size={size}
      strokeWidth={strokeWidth ?? iconStrokeWidth(size)}
      className={cx("px-icon", className)}
      {...rest}
    />
  );
}

export interface AppMarkProps {
  size?: number | undefined;
  /** Accessible name; omit when a visible wordmark sits next to it. */
  title?: string | undefined;
  className?: string | undefined;
}

/** The VISCERA mark: the coral trace of the site favicon on a dark tile (logo only, never interactive colour). */
export function AppMark({ size = 20, title, className }: AppMarkProps) {
  const gradient = useId();
  return (
    <svg
      className={cx("px-app-mark", className)}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#24313A" />
          <stop offset="1" stopColor="#0F171C" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="7.5" fill={`url(#${gradient})`} />
      <rect x=".5" y=".5" width="31" height="31" rx="7" fill="none" stroke="rgba(255,255,255,.12)" />
      <path d="M4.5 17h5.5l3-8.5 5 16 3-7.5h6.5" fill="none" stroke="#FF5C6C" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
