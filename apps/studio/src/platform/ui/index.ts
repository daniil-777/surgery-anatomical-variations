// The VISCERA px UI kit: Apple-style (macOS 26/27) components for the account shell (docs/platform/APPLE_STYLE_SPEC.md,
// adapted by DESIGN.md D2/D13). Wrap the shell in <PxProvider route="app|auth|lab">; it loads the tokens, the scoped
// base styles under html.px-shell and Inter (the fallback when SF is not available), sets the theme attributes on
// <html> and hosts toasts and the HUD. Labs run in iframes: nothing here styles lab DOM.
//
// Rules for callers: font sizes only through --px-fs-* custom properties; classes are .px-*; icons are lucide
// components passed by reference (the kit sizes them and sets the stroke).

import "./styles/px-tokens.css";
import "./styles/px-base.css";

export { PxProvider, usePx, useToast, useHud, type PxContextValue, type PxProviderProps } from "./components/PxProvider";
export { AppLayout, Window, SIDEBAR_SHORTCUT, useAppLayout, type AppLayoutProps, type AppLayoutContextValue } from "./components/AppLayout";
export { Toolbar, ToolbarGroup, ToolbarItem, type ToolbarProps, type ToolbarGroupProps, type ToolbarPriority } from "./components/Toolbar";
export {
  Sidebar,
  SidebarBrand,
  SidebarToggle,
  SidebarSection,
  SidebarItem,
  type SidebarProps,
  type SidebarBrandProps,
  type SidebarToggleProps,
  type SidebarSectionProps,
  type SidebarItemProps,
} from "./components/Sidebar";
export {
  Inspector,
  InspectorSection,
  InspectorRow,
  InspectorPlaceholder,
  type InspectorProps,
  type InspectorSectionProps,
  type InspectorRowProps,
} from "./components/Inspector";
export {
  Button,
  IconButton,
  type ButtonProps,
  type ButtonVariant,
  type ButtonSize,
  type IconButtonProps,
  type IconButtonVariant,
  type IconButtonSize,
} from "./components/Button";
export {
  TextField,
  TextArea,
  SecureField,
  SearchField,
  FormGroup,
  FormRow,
  type TextFieldProps,
  type TextAreaProps,
  type SecureFieldProps,
  type SearchFieldProps,
  type FormGroupProps,
  type FormRowProps,
  type FieldSize,
} from "./components/Fields";
export { Checkbox, Switch, type CheckboxProps, type SwitchProps } from "./components/Toggles";
export { SegmentedControl, type SegmentedControlProps, type SegmentedItem } from "./components/SegmentedControl";
export {
  Menu,
  MenuItem,
  MenuSeparator,
  MenuSection,
  MenuHeader,
  MenuButton,
  ContextMenu,
  PopUpButton,
  Select,
  type MenuProps,
  type MenuItemProps,
  type MenuSectionProps,
  type MenuButtonProps,
  type ContextMenuProps,
  type PopUpButtonProps,
  type PopUpOption,
  type SelectProps,
} from "./components/Menu";
export { Popover, type PopoverProps } from "./components/Popover";
export { Tooltip, useTooltip, type TooltipProps, type TooltipOptions } from "./components/Tooltip";
export { Sheet, Alert, type SheetProps, type AlertProps } from "./components/Dialogs";
export { type ToastOptions, type ToastTone, type ToastAction, type HudOptions } from "./components/Toast";
export {
  ProgressBar,
  ProgressRing,
  Spinner,
  Skeleton,
  type ProgressBarProps,
  type ProgressRingProps,
  type SpinnerProps,
  type SkeletonProps,
} from "./components/Progress";
export { EmptyState, Badge, KeyboardShortcut, type EmptyStateProps, type BadgeProps, type BadgeTone, type KeyboardShortcutProps } from "./components/Display";
export {
  Avatar,
  AccountButton,
  AccountMenuContent,
  type AvatarProps,
  type AccountButtonProps,
  type AccountMenuContentProps,
  type SyncState,
} from "./components/Avatar";
export { MediaGrid, MediaCard, Grid, type MediaGridProps, type MediaCardProps, type MediaRatio, type GridProps } from "./components/MediaCard";
export { StorageMeter, type StorageMeterProps, type StorageSegment } from "./components/StorageMeter";
export { Icon, AppMark, type IconProps, type AppMarkProps, type IconComponent } from "./components/Icon";

export { useShortcuts, type ShortcutHandler, type UseShortcutsOptions } from "./hooks/useShortcuts";
export { useRovingFocus, type UseRovingFocusOptions, type RovingItemProps } from "./hooks/useRovingFocus";
export { useScrolledEdge } from "./hooks/useScrolledEdge";
export { useMediaQuery, usePrefersReducedMotion, usePrefersDark, usePrefersReducedTransparency } from "./hooks/useMediaQuery";
export { useDeferredLoading } from "./hooks/useDeferredLoading";
export { useControllableState, useLatest, useMergedRefs } from "./hooks/useLatest";
export { useIsMac } from "./hooks/usePlatform";
export { usePopoverLayer, pointReference, type PopoverLayerOptions } from "./hooks/usePopoverLayer";

export * from "./lib/shortcuts";
export * from "./lib/theme";
export * from "./lib/format";
export { cx, cssVars, mergeRefs } from "./lib/dom";
