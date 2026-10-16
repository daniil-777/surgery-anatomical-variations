import type { ButtonHTMLAttributes, ReactNode } from "react";
import "./tokens.css";
export function IconButton({
  title,
  active = false,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      className={`icon-button ${active ? "active" : ""}`}
      title={title}
      aria-label={title}
      {...props}
    >
      {children}
    </button>
  );
}
export function Button({
  primary = false,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  primary?: boolean;
  children: ReactNode;
}) {
  return (
    <button className={`button ${primary ? "primary" : ""}`} {...props}>
      {children}
    </button>
  );
}
export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  unit = "",
  onChange,
  onStart,
  onEnd,
  disabled = false,
  testId,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  onChange: (v: number) => void;
  onStart?: () => void;
  onEnd?: () => void;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <div className="field-slider">
      <label className="field-slider-label">
        <span>{label}</span>
        <span className="field-slider-value">
          {Number.isInteger(value) ? value : value.toFixed(step < 0.1 ? 2 : 1)}
          <span className="field-slider-unit">{unit}</span>
        </span>
      </label>
      <input
        aria-label={label}
        data-testid={testId}
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onPointerDown={onStart}
        onPointerUp={onEnd}
        onKeyDown={(e) => {
          if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key))
            onStart?.();
        }}
        onKeyUp={onEnd}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}
export function Section({
  title,
  children,
  aside,
}: {
  title: string;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <section className="inspector-section">
      <h3 className="section-heading">
        {title}
        {aside}
      </h3>
      {children}
    </section>
  );
}
