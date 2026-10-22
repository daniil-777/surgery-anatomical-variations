import { useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cx, readStorage, writeStorage } from "../lib/dom";
import { Icon } from "./Icon";
import "./inspector.css";

export interface InspectorProps {
  "aria-label"?: string | undefined;
  /** The item name (Title 3 emphasized) in a 44 px header that stays put while the body scrolls. */
  title?: ReactNode;
  /** Trailing header controls (a close button, a menu). */
  headerAccessory?: ReactNode;
  /** 4:3 preview under the header (an image, a video, the shared turntable). */
  preview?: ReactNode;
  /** Sticky 52 px footer: the primary action ("Open in Tissue Lab") and a ⋯ menu. */
  footer?: ReactNode;
  children?: ReactNode;
  className?: string | undefined;
}

/** The right-hand info column (§2.10): solid window background, hairline leading edge, sections of label/value rows. */
export function Inspector({ title, headerAccessory, preview, footer, children, className, ...aria }: InspectorProps) {
  return (
    <aside aria-label={aria["aria-label"] ?? "Inspector"} className={cx("px-inspector", className)}>
      {title != null ? (
        <div className="px-inspector__header">
          <h2 className="px-inspector__title">{title}</h2>
          {headerAccessory}
        </div>
      ) : null}
      <div className="px-inspector__scroll">
        {preview ? <div className="px-inspector__preview">{preview}</div> : null}
        {children}
      </div>
      {footer ? <div className="px-inspector__footer">{footer}</div> : null}
    </aside>
  );
}

export interface InspectorSectionProps {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean | undefined;
  /** Remembers the open state across sessions (localStorage "viscera.px.inspector.<key>"). */
  persistKey?: string | undefined;
}

/** A disclosure section: 28 px header in Subheadline emphasized, hairline between sections. */
export function InspectorSection({ title, children, defaultOpen = true, persistKey }: InspectorSectionProps) {
  const bodyId = useId();
  const storageKey = persistKey ? `viscera.px.inspector.${persistKey}` : null;
  const [open, setOpen] = useState(() => {
    const stored = storageKey ? readStorage(storageKey) : null;
    return stored === null ? defaultOpen : stored === "1";
  });
  return (
    <div className="px-inspector-section">
      <h3 className="px-inspector-section__heading">
        <button
          type="button"
          className="px-inspector-section__toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => {
            setOpen(!open);
            if (storageKey) writeStorage(storageKey, open ? "0" : "1");
          }}
        >
          <span>{title}</span>
          <Icon icon={ChevronDown} size={10} strokeWidth={2.25} className="px-inspector-section__chevron" />
        </button>
      </h3>
      <div id={bodyId} className="px-inspector-section__body" hidden={!open}>
        {children}
      </div>
    </div>
  );
}

export interface InspectorRowProps {
  label: ReactNode;
  children?: ReactNode;
  /** The id of a control in the value cell, so the label names it. */
  htmlFor?: string | undefined;
}

/** "Format   glTF Binary 2.0": a 92 px label column and a Callout value; numbers should use .px-num. */
export function InspectorRow({ label, children, htmlFor }: InspectorRowProps) {
  return (
    <div className="px-inspector-row">
      {htmlFor ? (
        <label htmlFor={htmlFor} className="px-inspector-row__label">
          {label}
        </label>
      ) : (
        <span className="px-inspector-row__label">{label}</span>
      )}
      <span className="px-inspector-row__value">{children}</span>
    </div>
  );
}

/** "No Selection" / "3 Items" placeholder centred in the inspector. */
export function InspectorPlaceholder({ children }: { children: ReactNode }) {
  return <div className="px-inspector__placeholder">{children}</div>;
}
