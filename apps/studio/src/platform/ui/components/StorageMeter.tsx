import { useId } from "react";
import { cssVars, cx } from "../lib/dom";
import { formatBytes, formatPercent, storageFraction, storageLevel } from "../lib/format";
import "./meter.css";

export interface StorageSegment {
  id: string;
  /** "Projects", "Library", "Imports", "Recordings", "Versions". */
  label: string;
  bytes: number;
  /** CSS colour; defaults follow §3.7 by id, then the system grays. */
  color?: string | undefined;
}

export interface StorageMeterProps {
  usedBytes: number;
  quotaBytes: number;
  segments?: readonly StorageSegment[] | undefined;
  /** Headline + bar only (popovers, the sidebar). */
  compact?: boolean | undefined;
  className?: string | undefined;
}

const DEFAULT_COLORS: Record<string, string> = {
  projects: "var(--px-system-blue)",
  library: "var(--px-system-purple)",
  imports: "var(--px-system-orange)",
  recordings: "var(--px-system-pink)",
  versions: "var(--px-system-gray)",
};

/** "3.2 GB of 50 GB used", a segmented 8 px bar and a legend with values (never colour alone) — §3.7. */
export function StorageMeter({ usedBytes, quotaBytes, segments = [], compact = false, className }: StorageMeterProps) {
  const headlineId = useId();
  const level = storageLevel(usedBytes, quotaBytes);
  const fraction = storageFraction(usedBytes, quotaBytes);
  const total = Math.max(quotaBytes, 1);
  const parts = segments.filter((segment) => segment.bytes > 0);
  const valueText = `${formatBytes(usedBytes)} of ${formatBytes(quotaBytes)} used (${formatPercent(fraction)})`;
  return (
    <div className={cx("px-meter", `px-meter--${level}`, compact && "px-meter--compact", className)}>
      <div className="px-meter__header">
        <span id={headlineId} className="px-meter__headline px-num">
          {formatBytes(usedBytes)} of {formatBytes(quotaBytes)} used
        </span>
        {level === "warning" ? <span className="px-meter__status">Storage almost full</span> : null}
        {level === "full" ? <span className="px-meter__status">Storage full</span> : null}
      </div>
      <div
        className="px-meter__bar"
        role="meter"
        aria-labelledby={headlineId}
        aria-valuemin={0}
        aria-valuemax={quotaBytes}
        aria-valuenow={Math.min(usedBytes, quotaBytes)}
        aria-valuetext={valueText}
      >
        {parts.length > 0 ? (
          parts.map((segment) => (
            <span
              key={segment.id}
              className="px-meter__segment"
              style={cssVars({
                "--_share": `${(segment.bytes / total) * 100}%`,
                "--_color": segment.color ?? DEFAULT_COLORS[segment.id] ?? "var(--px-system-gray)",
              })}
            />
          ))
        ) : (
          <span className="px-meter__segment" style={cssVars({ "--_share": `${fraction * 100}%`, "--_color": "var(--px-accent)" })} />
        )}
      </div>
      {!compact && parts.length > 0 ? (
        <ul className="px-meter__legend" role="list">
          {parts.map((segment) => (
            <li key={segment.id} className="px-meter__legend-item">
              <span className="px-meter__dot" style={cssVars({ "--_color": segment.color ?? DEFAULT_COLORS[segment.id] ?? "var(--px-system-gray)" })} />
              <span>{segment.label}</span>
              <span className="px-meter__legend-value px-num">{formatBytes(segment.bytes)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
