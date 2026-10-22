import { useId, type CSSProperties, type ReactNode } from "react";
import { cssVars, cx } from "../lib/dom";
import { formatPercent } from "../lib/format";
import "./progress.css";

export interface SpinnerProps {
  /** 16, 20 or 32 in the spec; any size works. */
  size?: number | undefined;
  /** Gives the spinner a role and name; without it the spinner is decorative (e.g. inside a busy button). */
  label?: string | undefined;
  className?: string | undefined;
}

const SPOKES = Array.from({ length: 12 }, (_, index) => index);

/**
 * The macOS spinner: 12 rounded spokes (each 28 % of the size, outer tip at 48 % of it from the centre), opacity ramp,
 * stepped rotation. Keeps spinning under Reduce Motion (essential motion).
 */
export function Spinner({ size = 16, label, className }: SpinnerProps) {
  const width = Math.max((1.5 / size) * 100, 8);
  return (
    <svg
      className={cx("px-spinner", className)}
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <g className="px-spinner__wheel">
        {SPOKES.map((index) => (
          <line
            key={index}
            x1="50"
            y1={2 + width / 2}
            x2="50"
            y2={30 - width / 2}
            strokeWidth={width}
            strokeLinecap="round"
            opacity={0.25 + (0.75 * index) / 11}
            transform={`rotate(${index * 30} 50 50)`}
          />
        ))}
      </g>
    </svg>
  );
}

export interface ProgressBarProps {
  /** 0…1; null or undefined is indeterminate. */
  value?: number | null | undefined;
  /** Visible label above the bar ("Importing 3 of 5 Files…"); also names the progressbar. */
  label?: ReactNode;
  /** Accessible name when there is no visible label (defaults to "Progress"; name it after the task). */
  "aria-label"?: string | undefined;
  /** Shows the right-aligned percentage next to the label. */
  showValue?: boolean | undefined;
  /** "inline" is the 2 px bar used inside cards and import rows. */
  size?: "regular" | "inline" | undefined;
  className?: string | undefined;
  style?: CSSProperties | undefined;
}

export function ProgressBar({ value, label, showValue = false, size = "regular", className, style, ...aria }: ProgressBarProps) {
  const labelId = useId();
  const determinate = typeof value === "number" && Number.isFinite(value);
  const fraction = determinate ? Math.min(1, Math.max(0, value)) : 0;
  return (
    <div className={cx("px-progress", size === "inline" && "px-progress--inline", className)} style={style}>
      {label || (showValue && determinate) ? (
        <div className="px-progress__header">
          {label ? <span id={labelId} className="px-progress__label">{label}</span> : <span />}
          {showValue && determinate ? <span className="px-progress__value px-num">{formatPercent(fraction)}</span> : null}
        </div>
      ) : null}
      <div
        className="px-progress__track"
        role="progressbar"
        aria-labelledby={label ? labelId : undefined}
        aria-label={label ? undefined : aria["aria-label"] ?? "Progress"}
        aria-valuemin={determinate ? 0 : undefined}
        aria-valuemax={determinate ? 100 : undefined}
        aria-valuenow={determinate ? Math.round(fraction * 100) : undefined}
      >
        {determinate ? (
          <div className="px-progress__fill" style={{ width: `${fraction * 100}%` }} />
        ) : (
          <div className="px-progress__fill px-progress__fill--indeterminate" />
        )}
      </div>
    </div>
  );
}

export interface ProgressRingProps {
  /** 0…1. */
  value: number;
  size?: 16 | 20 | 32 | undefined;
  "aria-label"?: string | undefined;
  className?: string | undefined;
}

/** Circular determinate progress: starts at 12 o'clock, fills clockwise (§2.14). */
export function ProgressRing({ value, size = 16, className, ...aria }: ProgressRingProps) {
  const stroke = size === 32 ? 3 : size === 20 ? 2.5 : 2;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const fraction = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
  return (
    <svg
      className={cx("px-ring", className)}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="progressbar"
      aria-label={aria["aria-label"]}
      aria-hidden={aria["aria-label"] ? undefined : true}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(fraction * 100)}
      focusable="false"
    >
      <circle className="px-ring__track" cx={size / 2} cy={size / 2} r={radius} strokeWidth={stroke} fill="none" />
      <circle
        className="px-ring__fill"
        cx={size / 2}
        cy={size / 2}
        r={radius}
        strokeWidth={stroke}
        fill="none"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - fraction)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

export interface SkeletonProps {
  width?: number | string | undefined;
  height?: number | string | undefined;
  /** Radius of what it stands in for (cards 14, thumbnails 10, text bars 4). */
  radius?: number | string | undefined;
  circle?: boolean | undefined;
  className?: string | undefined;
}

/** A placeholder block with the shimmer of §2.14 (static under Reduce Motion). */
export function Skeleton({ width, height = 10, radius = 4, circle = false, className }: SkeletonProps) {
  const size = (value: number | string | undefined) => (typeof value === "number" ? `${value}px` : value);
  return (
    <span
      className={cx("px-skeleton", className)}
      aria-hidden="true"
      style={cssVars({
        "--_w": size(width) ?? "100%",
        "--_h": size(height),
        "--_r": circle ? "50%" : size(radius),
      })}
    />
  );
}
