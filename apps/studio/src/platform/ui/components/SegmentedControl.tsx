import type { LucideIcon } from "lucide-react";
import { cssVars, cx } from "../lib/dom";
import { useMergedRefs } from "../hooks/useLatest";
import { useRovingFocus, type RovingItemProps } from "../hooks/useRovingFocus";
import { Icon } from "./Icon";
import { useTooltip } from "./Tooltip";
import "./segmented.css";

export interface SegmentedItem<T extends string> {
  value: T;
  /** Title Case noun; the accessible name of icon-only segments. */
  label: string;
  icon?: LucideIcon | undefined;
  disabled?: boolean | undefined;
  /** Explains a disabled segment (shown on hover and focus). */
  tooltip?: string | undefined;
}

export interface SegmentedControlProps<T extends string> {
  /** 2–5 segments (HIG). */
  items: ReadonlyArray<SegmentedItem<T>>;
  value: T;
  onChange: (value: T) => void;
  "aria-label": string;
  /** regular 24 · large 28 · toolbar 36 glass (§2.4). */
  variant?: "regular" | "large" | "toolbar" | undefined;
  /** Icons only (never mix text and icons); labels become names and tooltips. */
  iconOnly?: boolean | undefined;
  fullWidth?: boolean | undefined;
  className?: string | undefined;
}

interface SegmentProps<T extends string> {
  item: SegmentedItem<T>;
  checked: boolean;
  iconOnly: boolean;
  iconSize: number;
  roving: RovingItemProps;
  onChoose: () => void;
}

function Segment<T extends string>({ item, checked, iconOnly, iconSize, roving, onChoose }: SegmentProps<T>) {
  const tip = item.tooltip ?? (iconOnly ? item.label : undefined);
  const { triggerProps, tooltip } = useTooltip({ content: tip, describe: item.tooltip !== undefined && !iconOnly, disabled: tip === undefined });
  const setRef = useMergedRefs(roving.ref, triggerProps.ref);
  return (
    <>
      <button
        ref={setRef}
        type="button"
        role="radio"
        aria-checked={checked}
        aria-label={iconOnly ? item.label : undefined}
        aria-describedby={triggerProps["aria-describedby"]}
        aria-disabled={item.disabled || undefined}
        tabIndex={roving.tabIndex}
        className="px-seg__item"
        onKeyDown={roving.onKeyDown}
        onFocus={(event) => {
          roving.onFocus(event);
          triggerProps.onFocus(event);
        }}
        onBlur={triggerProps.onBlur}
        onPointerEnter={triggerProps.onPointerEnter}
        onPointerLeave={triggerProps.onPointerLeave}
        onPointerDown={triggerProps.onPointerDown}
        onClick={() => {
          if (!item.disabled) onChoose();
        }}
      >
        {item.icon ? <Icon icon={item.icon} size={iconSize} /> : null}
        {iconOnly ? null : <span className="px-seg__label">{item.label}</span>}
      </button>
      {tooltip}
    </>
  );
}

/**
 * role="radiogroup" with one tab stop; ←/→, Home and End move and select (selection follows focus). The thumb
 * slides with the snappy spring; the selected label keeps its weight so nothing jitters.
 */
export function SegmentedControl<T extends string>({
  items,
  value,
  onChange,
  variant = "regular",
  iconOnly = false,
  fullWidth = false,
  className,
  ...aria
}: SegmentedControlProps<T>) {
  const index = items.findIndex((item) => item.value === value);
  const { getItemProps } = useRovingFocus({
    count: items.length,
    activeIndex: index,
    orientation: "horizontal",
    loop: true,
    isDisabled: (candidate) => items[candidate]?.disabled ?? false,
    onActiveIndexChange: (next) => {
      const item = items[next];
      if (item && !item.disabled && item.value !== value) onChange(item.value);
    },
  });
  return (
    <div
      role="radiogroup"
      aria-label={aria["aria-label"]}
      className={cx("px-seg", `px-seg--${variant}`, iconOnly && "px-seg--icons", fullWidth && "px-seg--full", className)}
      style={cssVars({ "--n": Math.max(1, items.length), "--i": Math.max(0, index) })}
    >
      <span className="px-seg__thumb" aria-hidden="true" hidden={index < 0} />
      {items.map((item, itemIndex) => (
        <Segment
          key={item.value}
          item={item}
          checked={itemIndex === index}
          iconOnly={iconOnly}
          iconSize={variant === "toolbar" ? 17 : 16}
          roving={getItemProps(itemIndex)}
          onChoose={() => {
            if (item.value !== value) onChange(item.value);
          }}
        />
      ))}
    </div>
  );
}
