import { useId, useState, type ReactNode } from "react";
import {
  AppWindow,
  Atom,
  Bell,
  Box,
  Bookmark,
  CircleUser,
  Columns3,
  Inbox,
  Keyboard as KeyboardIcon,
  Menu as MenuIcon,
  MessageSquare,
  MousePointerClick,
  Palette,
  PanelRight,
  TextCursorInput,
  ToggleRight,
  Type,
  type LucideIcon,
  Copy,
  Droplet,
  Droplets,
  Ellipsis,
  FolderClosed,
  Heart,
  History,
  ImagePlus,
  Images,
  Import,
  Info,
  Layers,
  LayoutGrid,
  List,
  Mail,
  Pencil,
  Plus,
  Redo2,
  Search as SearchIcon,
  Share,
  Shapes,
  SlidersHorizontal,
  Trash2,
  Undo2,
  Video,
} from "lucide-react";
import {
  AccountButton,
  AccountMenuContent,
  Alert,
  Avatar,
  Badge,
  Button,
  Checkbox,
  ContextMenu,
  EmptyState,
  FormGroup,
  FormRow,
  IconButton,
  Inspector,
  InspectorRow,
  InspectorSection,
  KeyboardShortcut,
  MediaCard,
  MediaGrid,
  Menu,
  MenuButton,
  MenuItem,
  MenuSection,
  MenuSeparator,
  Popover,
  PopUpButton,
  ProgressBar,
  ProgressRing,
  SearchField,
  SecureField,
  SegmentedControl,
  Select,
  Sheet,
  Skeleton,
  Spinner,
  StorageMeter,
  Switch,
  TextArea,
  TextField,
  ToolbarGroup,
  Tooltip,
  usePx,
  useToast,
  useHud,
  type PxTheme,
} from "../index";
import { THUMBS } from "./thumbs";

export interface GallerySectionInfo {
  id: string;
  label: string;
  icon: LucideIcon;
  group: "Foundations" | "Controls" | "Overlays" | "Content";
}

export const GALLERY_SECTIONS: GallerySectionInfo[] = [
  { id: "colors", label: "Colors", icon: Palette, group: "Foundations" },
  { id: "typography", label: "Typography", icon: Type, group: "Foundations" },
  { id: "buttons", label: "Buttons", icon: MousePointerClick, group: "Controls" },
  { id: "fields", label: "Text Fields", icon: TextCursorInput, group: "Controls" },
  { id: "toggles", label: "Toggles", icon: ToggleRight, group: "Controls" },
  { id: "segmented", label: "Segmented Controls", icon: Columns3, group: "Controls" },
  { id: "menus", label: "Menus & Pop-Ups", icon: MenuIcon, group: "Controls" },
  { id: "overlays", label: "Popovers & Tooltips", icon: MessageSquare, group: "Overlays" },
  { id: "dialogs", label: "Sheets & Alerts", icon: AppWindow, group: "Overlays" },
  { id: "feedback", label: "Toasts, HUD & Progress", icon: Bell, group: "Overlays" },
  { id: "media", label: "Media Grid", icon: Images, group: "Content" },
  { id: "inspector", label: "Inspector", icon: PanelRight, group: "Content" },
  { id: "empty", label: "Empty States", icon: Inbox, group: "Content" },
  { id: "account", label: "Account & Storage", icon: CircleUser, group: "Content" },
  { id: "keyboard", label: "Keyboard", icon: KeyboardIcon, group: "Content" },
];

function Section({ id, title, lede, children }: { id: string; title: string; lede?: string; children: ReactNode }) {
  const headingId = `${id}-heading`;
  return (
    <section id={id} className="px-gal-section" aria-labelledby={headingId}>
      <div className="px-gal-section__header">
        <h2 id={headingId} className="px-gal-section__title">
          {title}
        </h2>
        {lede ? <p className="px-gal-section__lede">{lede}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Panel({ children, title, wide = false }: { children: ReactNode; title?: string; wide?: boolean }) {
  return (
    <div className={wide ? "px-gal-panel px-gal-panel--scroll" : "px-gal-panel"}>
      {title ? <h3 className="px-gal-panel__title">{title}</h3> : null}
      {children}
    </div>
  );
}

function Cell({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <div className="px-gal-cell">
      <div className="px-gal-cell__body">{children}</div>
      <span className="px-gal-caption">{caption}</span>
    </div>
  );
}

const STATES = ["Rest", "Hover", "Pressed", "Focus", "Disabled", "Loading"] as const;

function stateProps(state: (typeof STATES)[number]) {
  if (state === "Hover") return { "data-px-state": "hover" };
  if (state === "Pressed") return { "data-px-state": "pressed" };
  if (state === "Focus") return { "data-px-state": "focus" };
  if (state === "Disabled") return { disabled: true };
  return {};
}

// Foundations ---------------------------------------------------------------------------------------------------------

const COLOR_GROUPS: Array<{ title: string; tokens: string[] }> = [
  { title: "Labels", tokens: ["label", "label-secondary", "label-tertiary", "label-quaternary"] },
  { title: "Backgrounds", tokens: ["bg-window", "bg-content", "bg-content-alt", "bg-grouped", "bg-elevated", "bg-thumb"] },
  { title: "Fills", tokens: ["fill", "fill-secondary", "fill-tertiary", "fill-quaternary"] },
  { title: "Accent & Status", tokens: ["accent", "accent-text", "selection", "danger-text", "success-text", "warning-text"] },
  {
    title: "System",
    tokens: ["system-red", "system-orange", "system-yellow", "system-green", "system-mint", "system-teal", "system-cyan", "system-blue", "system-indigo", "system-purple", "system-pink", "system-gray"],
  },
];

function Colors() {
  return (
    <Section id="colors" title="Colors" lede="Semantic tokens resolve per appearance with light-dark(); text tokens are tuned to WCAG AA on the surfaces they sit on.">
      {COLOR_GROUPS.map((group) => (
        <Panel key={group.title} title={group.title}>
          <div className="px-gal-swatches">
            {group.tokens.map((token) => (
              <div key={token} className="px-gal-swatch">
                <span className="px-gal-swatch__chip" style={{ background: `var(--px-${token})` }} />
                <span className="px-gal-caption">{token}</span>
              </div>
            ))}
          </div>
        </Panel>
      ))}
    </Section>
  );
}

const TEXT_STYLES = [
  ["px-large-title", "Large Title", "26/32"],
  ["px-title1", "Title 1", "22/26"],
  ["px-title2 px-em", "Title 2", "17/22"],
  ["px-title3 px-em", "Title 3", "15/20"],
  ["px-headline", "Headline", "13/16"],
  ["px-body", "Body", "13/16"],
  ["px-callout", "Callout", "12/15"],
  ["px-subheadline", "Subheadline", "11/14"],
  ["px-footnote", "Footnote", "10/13"],
  ["px-caption2", "Caption", "10/13"],
] as const;

function Typography() {
  return (
    <Section id="typography" title="Typography" lede="macOS text styles at desktop density. SF on Apple platforms, Inter Variable everywhere else.">
      <Panel>
        <div className="px-gal-type">
          {TEXT_STYLES.map(([className, name, metrics]) => (
            <div key={name} className="px-gal-type__row">
              <span className={className}>{name === "Large Title" ? "Liver Capsule Study" : `${name} — Wet coat tuned for 4K`}</span>
              <span className="px-gal-caption px-num">
                {name} · {metrics}
              </span>
            </div>
          ))}
        </div>
      </Panel>
    </Section>
  );
}

// Controls ------------------------------------------------------------------------------------------------------------

function Buttons() {
  const variants = [
    ["bordered", "Bordered", "Rename…"],
    ["borderedProminent", "Prominent", "Save"],
    ["plain", "Plain", "Show All"],
    ["destructive", "Destructive", "Delete…"],
    ["destructiveProminent", "Destructive Prominent", "Delete"],
  ] as const;
  return (
    <Section id="buttons" title="Buttons" lede="One prominent action per view, Title Case verbs, “…” when another view follows.">
      <Panel wide title="Variants × states">
        <div className="px-gal-matrix" role="presentation">
          <span />
          {STATES.map((state) => (
            <span key={state} className="px-gal-caption">
              {state}
            </span>
          ))}
          {variants.map(([variant, name, label]) => (
            <ButtonRow key={variant} variant={variant} name={name} label={label} />
          ))}
        </div>
      </Panel>
      <Panel title="Sizes">
        <div className="px-gal-row px-gal-row--end">
          <Cell caption="Small · 20">
            <Button size="small">Edit</Button>
          </Cell>
          <Cell caption="Regular · 24">
            <Button icon={Share}>Export…</Button>
          </Cell>
          <Cell caption="Large · 28">
            <Button size="large" variant="borderedProminent">
              Restore
            </Button>
          </Cell>
          <Cell caption="X-Large · 36">
            <Button size="xlarge" variant="borderedProminent" icon={Plus}>
              New Project
            </Button>
          </Cell>
          <Cell caption="Toolbar · glass">
            <Button size="toolbar" variant="glass">
              Import…
            </Button>
          </Cell>
        </div>
        <div className="px-gal-auth">
          <Cell caption="Auth · 40, full width">
            <Button size="auth" variant="borderedProminent">
              Sign In
            </Button>
          </Cell>
        </div>
      </Panel>
      <Panel title="Icon buttons">
        <div className="px-gal-row px-gal-row--end">
          <Cell caption="Plain">
            <IconButton icon={Info} label="Get Info" shortcut="mod+i" />
          </Cell>
          <Cell caption="Plain · pressed">
            <IconButton icon={Bookmark} label="Name This Version" pressed />
          </Cell>
          <Cell caption="Bordered">
            <IconButton icon={Copy} label="Duplicate" variant="bordered" />
          </Cell>
          <Cell caption="Glass">
            <IconButton icon={SearchIcon} label="Search" variant="glass" />
          </Cell>
          <Cell caption="Disabled">
            <IconButton icon={Trash2} label="Move to Trash" variant="bordered" disabled />
          </Cell>
          <Cell caption="Toolbar group">
            <ToolbarGroup aria-label="Edit">
              <IconButton icon={Undo2} label="Undo" shortcut="mod+z" variant="toolbar" size="toolbar" />
              <IconButton icon={Redo2} label="Redo" shortcut="shift+mod+z" variant="toolbar" size="toolbar" disabled />
              <IconButton icon={History} label="Version History" shortcut="alt+mod+y" variant="toolbar" size="toolbar" pressed />
            </ToolbarGroup>
          </Cell>
          <Cell caption="Record">
            <ToolbarGroup>
              <IconButton icon={Video} label="Record" variant="toolbar" size="toolbar" tint="var(--px-system-red)" />
            </ToolbarGroup>
          </Cell>
        </div>
      </Panel>
    </Section>
  );
}

function ButtonRow({ variant, name, label }: { variant: "bordered" | "borderedProminent" | "plain" | "destructive" | "destructiveProminent"; name: string; label: string }) {
  return (
    <>
      <span className="px-gal-caption px-gal-matrix__label">{name}</span>
      {STATES.map((state) => (
        <span key={state}>
          <Button variant={variant} loading={state === "Loading"} loadingLabel="Saving…" {...stateProps(state)}>
            {label}
          </Button>
        </span>
      ))}
    </>
  );
}

function Fields() {
  const [email, setEmail] = useState("daniil@example.com");
  const [query, setQuery] = useState("liver");
  const [sort, setSort] = useState<"edited" | "name" | "lab" | "size">("edited");
  const [lab, setLab] = useState("tissue");
  const passwordId = useId();
  return (
    <Section id="fields" title="Text Fields" lede="Labels always sit above the field; placeholders are examples. Errors explain what to do.">
      <div className="px-gal-columns">
        <Panel title="Sizes and states">
          <div className="px-gal-stack">
            <TextField label="Name" size="regular" defaultValue="Liver baseline" hint="Regular · 24, used in the inspector." />
            <TextField label="Email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} leadingIcon={Mail} placeholder="name@example.com" />
            <TextField label="Version Name" defaultValue="Version 5" error="Enter a name with at most 60 characters." />
            <TextField label="Project ID" defaultValue="liver-capsule-7f3a" readOnly hint="Read-only." />
            <TextField label="Organization" placeholder="Optional" disabled />
            <TextArea label="Description" placeholder="What changed in this version?" />
          </div>
        </Panel>
        <Panel title="Sign-in fields">
          <div className="px-gal-stack">
            <TextField label="Email" size="auth" type="email" autoComplete="username" placeholder="name@example.com" />
            <SecureField
              id={passwordId}
              label="Password"
              size="auth"
              autoComplete="current-password"
              defaultValue="correct horse"
              labelAccessory={<a href="#fields">Forgot Password?</a>}
            />
            <SecureField label="New Password" size="large" autoComplete="new-password" hint="At least 8 characters." />
          </div>
          <h3 className="px-gal-panel__title">Search</h3>
          <div className="px-gal-stack">
            <SearchField label="Search Library" value={query} onChange={setQuery} />
            <div className="px-gal-row">
              <SearchField label="Search Imports" variant="toolbar" />
            </div>
          </div>
          <h3 className="px-gal-panel__title">Pop-ups</h3>
          <div className="px-gal-row">
            <Cell caption="Native select">
              <Select aria-label="Role" defaultValue="researcher">
                <option value="researcher">Researcher</option>
                <option value="surgeon">Surgeon</option>
                <option value="educator">Educator</option>
                <option value="student">Student</option>
              </Select>
            </Cell>
            <Cell caption="Pop-up button">
              <PopUpButton
                label="Sort By"
                value={sort}
                onChange={setSort}
                options={[
                  { value: "edited", label: "Date Edited" },
                  { value: "name", label: "Name" },
                  { value: "lab", label: "Lab" },
                  "separator",
                  { value: "size", label: "Size" },
                ]}
              />
            </Cell>
            <Cell caption="Toolbar pop-up">
              <PopUpButton
                label="Lab"
                variant="glass"
                size="toolbar"
                value={lab}
                onChange={setLab}
                options={[
                  { value: "organ", label: "Organ Lab" },
                  { value: "tissue", label: "Tissue Lab" },
                  { value: "physics", label: "Physics Lab" },
                ]}
              />
            </Cell>
          </div>
        </Panel>
      </div>
      <Panel title="Grouped form (sheets, Account)">
        <FormGroup title="Appearance" footer="Labs always use Dark appearance.">
          <FormRow label="Appearance" description="Follows macOS when set to System.">
            <AppearanceSegmented />
          </FormRow>
          <FormRow label="Reduce Transparency" description="Uses the system setting when off.">
            <ReduceTransparencySwitch />
          </FormRow>
          <FormRow label="Plan">Pro · 50 GB</FormRow>
        </FormGroup>
      </Panel>
    </Section>
  );
}

function AppearanceSegmented() {
  const { appearance, setAppearance } = usePx();
  return (
    <SegmentedControl<PxTheme>
      aria-label="Appearance"
      value={appearance.theme}
      onChange={(theme) => setAppearance({ theme })}
      items={[
        { value: "system", label: "System" },
        { value: "light", label: "Light" },
        { value: "dark", label: "Dark" },
      ]}
    />
  );
}

function ReduceTransparencySwitch() {
  const { appearance, setAppearance } = usePx();
  return (
    <Switch
      aria-label="Reduce Transparency"
      size="small"
      checked={appearance.transparency === "reduce"}
      onChange={(event) => setAppearance({ transparency: event.target.checked ? "reduce" : "system" })}
    />
  );
}

function Toggles() {
  const [autosave, setAutosave] = useState(true);
  return (
    <Section id="toggles" title="Toggles" lede="Checkboxes for lists of settings; switches only for emphasized or group settings.">
      <div className="px-gal-columns">
        <Panel title="Checkbox">
          <div className="px-gal-stack px-gal-stack--tight">
            <Checkbox label="Unchecked" />
            <Checkbox label="Checked" defaultChecked />
            <Checkbox label="Mixed" indeterminate />
            <Checkbox label="Disabled" disabled />
            <Checkbox label="Disabled, checked" disabled defaultChecked />
            <Checkbox label="Send me occasional product updates" description="About once a month. Unsubscribe any time." />
          </div>
        </Panel>
        <Panel title="Switch">
          <div className="px-gal-stack px-gal-stack--tight">
            <Switch label="Autosave" checked={autosave} onChange={(event) => setAutosave(event.target.checked)} />
            <Switch label="Off" />
            <Switch label="Small" size="small" defaultChecked />
            <Switch label="Mini" size="mini" defaultChecked />
            <Switch label="Disabled" disabled />
            <Switch label="Trailing label" labelPosition="trailing" defaultChecked />
          </div>
        </Panel>
      </div>
    </Section>
  );
}

function Segmented() {
  const [scope, setScope] = useState("all");
  const [view, setView] = useState("grid");
  const [mode, setMode] = useState("surface");
  const [lighting, setLighting] = useState("camera");
  return (
    <Section id="segmented" title="Segmented Controls" lede="Selection follows focus; ←/→ move, Home/End jump. Text or icons, never mixed.">
      <Panel>
        <div className="px-gal-row px-gal-row--wrap">
          <Cell caption="Regular · 24">
            <SegmentedControl
              aria-label="Library scope"
              value={scope}
              onChange={setScope}
              items={[
                { value: "all", label: "All" },
                { value: "shapes", label: "Shapes" },
                { value: "materials", label: "Materials" },
                { value: "recordings", label: "Recordings" },
              ]}
            />
          </Cell>
          <Cell caption="Icons">
            <SegmentedControl
              aria-label="View"
              iconOnly
              value={view}
              onChange={setView}
              items={[
                { value: "grid", label: "Grid", icon: LayoutGrid },
                { value: "list", label: "List", icon: List },
              ]}
            />
          </Cell>
          <Cell caption="Large · 28, disabled segment">
            <SegmentedControl
              aria-label="Lighting"
              variant="large"
              value={lighting}
              onChange={setLighting}
              items={[
                { value: "camera", label: "Camera-Mounted" },
                { value: "grazing", label: "Grazing" },
                { value: "studio", label: "Studio", disabled: true, tooltip: "Studio lighting needs Native 4K maps" },
              ]}
            />
          </Cell>
          <Cell caption="Toolbar · 36 glass">
            <SegmentedControl
              aria-label="Tissue view"
              variant="toolbar"
              value={mode}
              onChange={setMode}
              items={[
                { value: "surface", label: "Surface" },
                { value: "organ", label: "Organ" },
                { value: "endoscope", label: "Endoscope" },
              ]}
            />
          </Cell>
        </div>
      </Panel>
    </Section>
  );
}

function Menus() {
  const [theme, setTheme] = useState<PxTheme>("system");
  return (
    <Section id="menus" title="Menus & Pop-Ups" lede="↑/↓ wrap, type-ahead, Return chooses with a blink, Escape returns focus. Right-click, Shift+F10 or the menu key open context menus.">
      <div className="px-gal-columns px-gal-columns--three">
        <Panel title="Item states">
          <Menu open onOpenChange={() => undefined} anchor={null} static aria-label="Item states">
            <MenuItem icon={FolderClosed} shortcut="mod+o">
              Open
            </MenuItem>
            <MenuItem icon={Layers} data-px-state="highlighted">
              Open in Tissue Lab
            </MenuItem>
            <MenuItem icon={SearchIcon} shortcut="space">
              Quick Look
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={Heart} shortcut=".">
              Add to Favorites
            </MenuItem>
            <MenuItem icon={Pencil} disabled>
              Rename
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={Trash2} shortcut="mod+backspace" destructive>
              Move to Trash
            </MenuItem>
          </Menu>
        </Panel>
        <Panel title="Sections and checks">
          <Menu open onOpenChange={() => undefined} anchor={null} static aria-label="Sections and checks">
            <MenuSection title="Group By">
              <MenuItem type="radio" checked>
                Date
              </MenuItem>
              <MenuItem type="radio" checked={false}>
                Kind
              </MenuItem>
              <MenuItem type="radio" checked={false}>
                Lab
              </MenuItem>
            </MenuSection>
            <MenuSeparator />
            <MenuItem checked>Show Titles</MenuItem>
            <MenuItem checked={false}>Aspect Ratio Grid</MenuItem>
          </Menu>
        </Panel>
        <Panel title="Account menu">
          <Menu open onOpenChange={() => undefined} anchor={null} static aria-label="Account menu sample">
            <AccountMenuContent
              name="Daniil Emtsev"
              email="daniil@example.com"
              appearance={theme}
              onAppearanceChange={setTheme}
              onAccountSettings={() => undefined}
              onStorage={() => undefined}
              onKeyboardShortcuts={() => undefined}
              onHelp={() => undefined}
              onSignOut={() => undefined}
            />
          </Menu>
        </Panel>
      </div>
      <Panel title="Live">
        <div className="px-gal-row px-gal-row--wrap">
          <MenuButton
            variant="borderedProminent"
            icon={Plus}
            menu={
              <>
                <MenuItem icon={Shapes} shortcut="alt+mod+n">
                  Organ Lab
                </MenuItem>
                <MenuItem icon={Layers}>Tissue Lab</MenuItem>
                <MenuItem icon={Droplet}>Fat Lab</MenuItem>
                <MenuItem icon={Droplets}>Blood Lab</MenuItem>
                <MenuItem icon={Atom}>Physics Lab</MenuItem>
              </>
            }
          >
            New Project
          </MenuButton>
          <MenuButton
            icon={SlidersHorizontal}
            menu={
              <>
                <MenuItem type="radio" checked>
                  Date Added
                </MenuItem>
                <MenuItem type="radio" checked={false}>
                  Name
                </MenuItem>
                <MenuItem type="radio" checked={false}>
                  Size
                </MenuItem>
              </>
            }
          >
            View
          </MenuButton>
          <ContextMenu
            aria-label="Card actions"
            menu={
              <>
                <MenuItem>Open</MenuItem>
                <MenuItem>Quick Look</MenuItem>
                <MenuSeparator />
                <MenuItem>Duplicate</MenuItem>
                <MenuItem destructive>Move to Trash</MenuItem>
              </>
            }
          >
            <div className="px-gal-context" tabIndex={0} aria-label="Context menu target: right-click or press Shift+F10">
              Right-click here
            </div>
          </ContextMenu>
        </div>
      </Panel>
    </Section>
  );
}

// Overlays ------------------------------------------------------------------------------------------------------------

function Overlays() {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("Version 5");
  return (
    <Section id="overlays" title="Popovers & Tooltips" lede="Popovers light-dismiss and apply edits as they happen. Tooltips appear after 700 ms, immediately on keyboard focus.">
      <div className="px-gal-columns">
        <Panel title="Popover">
          <div className="px-gal-row">
            <Button ref={setAnchor} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}>
              Save Version…
            </Button>
          </div>
          <Popover
            open={open}
            onOpenChange={setOpen}
            anchor={anchor}
            title="Save Version"
            width={300}
            footer={
              <>
                <Button onClick={() => setOpen(false)}>Cancel</Button>
                <Button variant="borderedProminent" onClick={() => setOpen(false)}>
                  Save Version
                </Button>
              </>
            }
          >
            <div className="px-gal-stack">
              <TextField label="Name" value={name} onChange={(event) => setName(event.target.value)} />
              <p className="px-footnote px-secondary">No changes since “Version 4”.</p>
            </div>
          </Popover>
          <div className="px-gal-static-popover" aria-hidden="true">
            <div className="px-popover px-gal-static" data-positioned="" data-placement="bottom">
              <div className="px-popover__scroll">
                <div className="px-popover__header">
                  <span className="px-popover__title">Liver Capsule Study</span>
                </div>
                <div className="px-popover__body px-gal-stack px-gal-stack--tight">
                  <span className="px-subheadline px-secondary">Tissue Lab · Projects</span>
                  <span className="px-subheadline px-secondary">Last saved Today at 14:32</span>
                </div>
              </div>
            </div>
          </div>
        </Panel>
        <Panel title="Tooltips">
          <div className="px-gal-row">
            <IconButton icon={History} label="Version History" shortcut="alt+mod+y" variant="bordered" />
            <IconButton icon={Info} label="Get Info" shortcut="mod+i" variant="bordered" />
            <Tooltip content="Studio lighting needs Native 4K maps">
              <Button aria-disabled>Studio</Button>
            </Tooltip>
          </div>
          <div className="px-gal-row" aria-hidden="true">
            <div className="px-tooltip px-gal-static" data-positioned="">
              <span className="px-tooltip__text">Version History</span>
              <span className="px-tooltip__shortcut">⌥⌘Y</span>
            </div>
            <div className="px-tooltip px-gal-static" data-positioned="">
              <span className="px-tooltip__text">Caps Lock is on</span>
            </div>
          </div>
        </Panel>
      </div>
    </Section>
  );
}

function Dialogs() {
  const [sheet, setSheet] = useState<"none" | "form" | "settings">("none");
  const [alert, setAlert] = useState<"none" | "delete" | "info">("none");
  const toast = useToast();
  return (
    <Section id="dialogs" title="Sheets & Alerts" lede="Native <dialog> with showModal(): focus moves in, Escape cancels, focus returns to the button that opened it.">
      <Panel>
        <div className="px-gal-row px-gal-row--wrap">
          <Button onClick={() => setSheet("form")}>Save as New Project…</Button>
          <Button onClick={() => setSheet("settings")}>Account Settings…</Button>
          <Button variant="destructive" onClick={() => setAlert("delete")}>
            Delete Project…
          </Button>
          <Button onClick={() => setAlert("info")}>Show Informational Alert</Button>
        </div>
      </Panel>
      <Sheet
        open={sheet === "form"}
        onClose={() => setSheet("none")}
        title="Save as New Project"
        size="small"
        actions={
          <>
            <Button onClick={() => setSheet("none")}>Cancel</Button>
            <Button
              variant="borderedProminent"
              onClick={() => {
                setSheet("none");
                toast.show({ message: "Saved “Liver baseline copy”.", tone: "success", action: { label: "Open", onAction: () => undefined } });
              }}
            >
              Save
            </Button>
          </>
        }
      >
        <TextField label="Name" defaultValue="Liver baseline copy" />
        <TextArea label="Description" placeholder="Optional" />
      </Sheet>
      <Sheet
        open={sheet === "settings"}
        onClose={() => setSheet("none")}
        title="Account"
        description="Changes apply immediately."
        grouped
        leadingActions={<Button onClick={() => setSheet("none")}>Sign Out</Button>}
        actions={
          <Button variant="borderedProminent" onClick={() => setSheet("none")}>
            Done
          </Button>
        }
      >
        <div className="px-gal-account-header">
          <Avatar name="Daniil Emtsev" size={64} />
          <div>
            <p className="px-title2 px-em">Daniil Emtsev</p>
            <p className="px-secondary">daniil@example.com</p>
          </div>
        </div>
        <FormGroup title="Profile">
          <FormRow label="Name">
            <TextField label="Name" hideLabel defaultValue="Daniil Emtsev" size="regular" />
          </FormRow>
          <FormRow label="Role">
            <Select aria-label="Role" defaultValue="researcher">
              <option value="researcher">Researcher</option>
              <option value="developer">Developer</option>
            </Select>
          </FormRow>
        </FormGroup>
        <FormGroup title="Plan & Storage">
          <FormRow label="Plan">Pro · 50 GB</FormRow>
          <div className="px-gal-form-meter">
            <StorageMeter usedBytes={3_200_000_000} quotaBytes={50_000_000_000} segments={STORAGE_SEGMENTS} />
          </div>
        </FormGroup>
      </Sheet>
      <Alert
        open={alert === "delete"}
        onClose={() => setAlert("none")}
        title="Delete “Liver Study”?"
        message="This project and its 14 versions will be deleted. You can’t undo this action."
        actionLabel="Delete"
        destructive
        onAction={() => setAlert("none")}
      />
      <Alert
        open={alert === "info"}
        onClose={() => setAlert("none")}
        title="Storage Full"
        message="New versions are paused until you free up space or change your plan."
        actionLabel="OK"
        cancelLabel={null}
        onAction={() => setAlert("none")}
      />
    </Section>
  );
}

const STORAGE_SEGMENTS = [
  { id: "projects", label: "Projects", bytes: 1_400_000_000 },
  { id: "library", label: "Library", bytes: 900_000_000 },
  { id: "imports", label: "Imports", bytes: 400_000_000 },
  { id: "recordings", label: "Recordings", bytes: 350_000_000 },
  { id: "versions", label: "Versions", bytes: 150_000_000 },
];

function Feedback() {
  const toast = useToast();
  const hud = useHud();
  return (
    <Section id="feedback" title="Toasts, HUD & Progress" lede="Toasts for action feedback with Undo; the HUD for brief confirmations. Indicators keep moving under Reduce Motion.">
      <div className="px-gal-columns">
        <Panel title="Toasts and HUD">
          <div className="px-gal-row px-gal-row--wrap">
            <Button
              onClick={() =>
                toast.show({ message: "Moved “Liver Study” to the Trash.", action: { label: "Undo", onAction: () => undefined }, icon: Trash2 })
              }
            >
              Toast with Undo
            </Button>
            <Button onClick={() => toast.show({ message: "Restored “Liver baseline”.", tone: "success" })}>Success Toast</Button>
            <Button
              variant="destructive"
              onClick={() =>
                toast.show({ message: "Couldn’t export “Liver.glb”.", tone: "error", action: { label: "Try Again", onAction: () => undefined } })
              }
            >
              Error Toast
            </Button>
            <Button onClick={() => hud({ label: "Version Saved" })}>Show HUD</Button>
          </div>
          <div className="px-gal-row" aria-hidden="true">
            <div className="px-toast px-gal-static">
              <Trash2 size={16} strokeWidth={1.75} className="px-toast__icon" color="var(--px-accent)" />
              <p className="px-toast__message">Moved “Liver Study” to the Trash.</p>
              <span className="px-btn px-btn--plain px-btn--regular px-toast__action">Undo</span>
            </div>
          </div>
        </Panel>
        <Panel title="Progress">
          <div className="px-gal-stack">
            <ProgressBar value={0.62} label="Importing 3 of 5 Files…" showValue />
            <ProgressBar label="Preparing Renderer…" />
            <ProgressBar value={0.35} size="inline" aria-label="Upload progress" />
            <div className="px-gal-row">
              <Cell caption="Ring 16 / 20 / 32">
                <span className="px-gal-row">
                  <ProgressRing value={0.25} size={16} aria-label="25 percent" />
                  <ProgressRing value={0.6} size={20} aria-label="60 percent" />
                  <ProgressRing value={0.85} size={32} aria-label="85 percent" />
                </span>
              </Cell>
              <Cell caption="Spinner 16 / 20 / 32">
                <span className="px-gal-row">
                  <Spinner size={16} label="Loading" />
                  <Spinner size={20} label="Loading" />
                  <Spinner size={32} label="Loading" />
                </span>
              </Cell>
            </div>
            <Cell caption="Skeleton">
              <span className="px-gal-skeleton">
                <Skeleton width={56} height={42} radius={8} />
                <span className="px-gal-stack px-gal-stack--tight">
                  <Skeleton width={160} />
                  <Skeleton width={110} />
                </span>
              </span>
            </Cell>
          </div>
        </Panel>
      </div>
      <Panel title="Badges">
        <div className="px-gal-row px-gal-row--wrap">
          <Badge>Autosave</Badge>
          <Badge tone="accent" icon={Bookmark}>
            Named
          </Badge>
          <Badge tone="success">Synced</Badge>
          <Badge tone="warning">Deletes in 3 days</Badge>
          <Badge tone="danger">Couldn’t Save</Badge>
          <span className="px-gal-hud-surface">
            <Badge tone="hud">4K · PBR</Badge>
          </span>
        </div>
      </Panel>
    </Section>
  );
}

// Content -------------------------------------------------------------------------------------------------------------

interface DemoItem {
  id: string;
  title: string;
  subtitle: string;
  thumb?: string;
  kind: typeof Shapes;
  duration?: string;
  badge?: string;
  status?: "ready" | "loading" | "processing" | "error";
  progress?: number;
}

const DEMO_ITEMS: DemoItem[] = [
  { id: "liver", title: "Liver capsule · wet", subtitle: "Material · Tissue Lab", thumb: THUMBS.liver, kind: Layers, badge: "4K · PBR" },
  { id: "mucosa", title: "Colon mucosa", subtitle: "Material · Tissue Lab", thumb: THUMBS.mucosa, kind: Layers },
  { id: "kidney", title: "Left kidney, variant 12", subtitle: "Shape · Organ Lab", thumb: THUMBS.kidney, kind: Shapes },
  { id: "contact", title: "Probe contact run", subtitle: "Recording · Physics Lab", thumb: THUMBS.contact, kind: Video, duration: "0:42" },
  { id: "gallbladder", title: "Gallbladder", subtitle: "Shape · Organ Lab", thumb: THUMBS.gallbladder, kind: Shapes },
  { id: "fat", title: "Lobular fat", subtitle: "Material · Fat Lab", thumb: THUMBS.fat, kind: Droplet, status: "processing", progress: 0.64 },
  { id: "vessels", title: "Hepatic vessels", subtitle: "Shape · Blood Lab", thumb: THUMBS.vessels, kind: Droplets },
  { id: "missing", title: "Stomach, imported", subtitle: "Model · Blender 4.2", kind: Box, status: "error" },
];

function Media() {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(["kidney"]));
  const [favorites, setFavorites] = useState<Set<string>>(() => new Set(["liver", "contact"]));
  const [projects, setProjects] = useState<Set<string>>(() => new Set());
  const toast = useToast();
  const toggleFavorite = (ids: string[]) =>
    setFavorites((current) => {
      const next = new Set(current);
      const add = ids.some((id) => !next.has(id));
      for (const id of ids) {
        if (add) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  return (
    <Section id="media" title="Media Grid" lede="Click selects, ⌘-click toggles, ⇧-click extends. Arrows move in two dimensions, “.” favourites, ⌘⌫ moves to the Trash.">
      <Panel>
        <MediaGrid
          aria-label="Library"
          selected={selected}
          onSelectionChange={setSelected}
          onToggleFavorite={toggleFavorite}
          onOpen={(id) => toast.show({ message: `Open “${DEMO_ITEMS.find((item) => item.id === id)?.title ?? id}”.` })}
          onDelete={(ids) => toast.show({ message: `Moved ${ids.length === 1 ? "1 item" : `${ids.length} items`} to the Trash.`, action: { label: "Undo", onAction: () => undefined } })}
          tileMin={150}
        >
          {DEMO_ITEMS.map((item, index) => (
            <MediaCard
              key={item.id}
              id={item.id}
              title={item.title}
              subtitle={item.subtitle}
              thumbnail={item.thumb ?? null}
              kindIcon={item.kind}
              duration={item.duration}
              badges={item.badge ? <span className="px-badge px-badge--hud">{item.badge}</span> : undefined}
              description={item.badge}
              favorite={favorites.has(item.id)}
              onFavoriteChange={() => toggleFavorite([item.id])}
              onMore={() => undefined}
              status={item.status}
              progress={item.progress}
              forceHover={index === 1}
            />
          ))}
        </MediaGrid>
      </Panel>
      <Panel title="Projects · 16:10">
        <MediaGrid aria-label="Recent projects" selected={projects} onSelectionChange={setProjects} multiselect={false} tileMin={220}>
          <MediaCard id="p1" title="Liver Capsule Study" subtitle="Tissue Lab · Edited 2 h ago" thumbnail={THUMBS.liver} ratio="16:10" />
          <MediaCard id="p2" title="Stomach Variations" subtitle="Organ Lab · Edited yesterday" thumbnail={THUMBS.stomach} ratio="16:10" />
          <MediaCard
            id="p3"
            title="Untitled Physics Project"
            subtitle="Physics Lab · Edited Oct 14"
            ratio="16:10"
            placeholder={
              <span className="px-gal-lab-placeholder">
                <Atom size={28} strokeWidth={1.5} />
              </span>
            }
          />
          <MediaCard id="p4" title="Loading…" subtitle="Organ Lab" ratio="16:10" status="loading" />
        </MediaGrid>
      </Panel>
    </Section>
  );
}

function InspectorDemo() {
  return (
    <Section id="inspector" title="Inspector" lede="Sections of label/value rows with a sticky header and footer. Provenance wording is copied from the lab, never upgraded.">
      <div className="px-gal-inspector-frame">
        <Inspector
          aria-label="Item inspector sample"
          title="Liver capsule · wet"
          preview={<img src={THUMBS.liver} alt="" />}
          footer={
            <>
              <Button variant="borderedProminent">Open in Tissue Lab</Button>
              <IconButton icon={Ellipsis} label="More Actions" variant="bordered" />
            </>
          }
        >
          <InspectorSection title="Material">
            <InspectorRow label="Tissue region">Liver capsule</InspectorRow>
            <InspectorRow label="Lab">Tissue Lab</InspectorRow>
            <InspectorRow label="Map resolution">
              <span className="px-num">Native 4096</span>
            </InspectorRow>
            <InspectorRow label="Variation seed">
              <span className="px-num">1 847 223 905</span>
            </InspectorRow>
            <InspectorRow label="Provenance">Procedural — not measured tissue optics</InspectorRow>
          </InspectorSection>
          <InspectorSection title="Tags" defaultOpen={false}>
            <InspectorRow label="Tags">capsule, wet, 4K</InspectorRow>
          </InspectorSection>
        </Inspector>
      </div>
    </Section>
  );
}

function EmptyStates() {
  return (
    <Section id="empty" title="Empty States" lede="Say what is missing and what to do.">
      <div className="px-gal-columns">
        <Panel>
          <EmptyState
            icon={Images}
            title="No Items Yet"
            description="Shapes, materials and recordings you save from a lab appear here."
            action={<Button icon={Plus}>Open a Lab</Button>}
            headingLevel={3}
          />
        </Panel>
        <Panel>
          <EmptyState icon={SearchIcon} title="No Results for “liver capsule”" description="Check the spelling or try a new search." headingLevel={3} />
        </Panel>
      </div>
      <Panel>
        <EmptyState
          icon={Import}
          title="Bring In Your Models"
          description="GLB · glTF · OBJ · STL from Unity or Blender, with .bin, .mtl and textures."
          action={
            <Button size="large" icon={ImagePlus}>
              Import Files…
            </Button>
          }
          headingLevel={3}
        />
      </Panel>
    </Section>
  );
}

function Account() {
  const [theme, setTheme] = useState<PxTheme>("system");
  return (
    <Section id="account" title="Account & Storage" lede="Avatars fall back to Contacts-style initials; storage is never shown by colour alone.">
      <div className="px-gal-columns">
        <Panel title="Avatars">
          <div className="px-gal-row px-gal-row--end">
            <Cell caption="16">
              <Avatar name="Daniil Emtsev" size={16} />
            </Cell>
            <Cell caption="24">
              <Avatar name="Ada Lovelace" size={24} />
            </Cell>
            <Cell caption="28">
              <Avatar name="Daniil Emtsev" size={28} />
            </Cell>
            <Cell caption="64 · photo">
              <Avatar name="Daniil Emtsev" src={THUMBS.stomach} size={64} alt="Daniil Emtsev" />
            </Cell>
            <Cell caption="64 · broken photo">
              <Avatar name="Grace Hopper" src="data:image/png;base64,broken" size={64} />
            </Cell>
          </div>
          <h3 className="px-gal-panel__title">Sidebar account row</h3>
          <div className="px-gal-account-rows">
            <AccountButton name="Daniil Emtsev" email="daniil@example.com" subtitle="Pro · 3.2 of 50 GB" sync="synced" appearance={theme} onAppearanceChange={setTheme} onSignOut={() => undefined} />
            <AccountButton name="Daniil Emtsev" subtitle="Free · 460 of 500 MB" usageLevel="warning" sync="syncing" appearance={theme} onAppearanceChange={setTheme} />
            <AccountButton name="Daniil Emtsev" subtitle="Free · 500 of 500 MB" usageLevel="full" sync="offline" appearance={theme} onAppearanceChange={setTheme} />
            <AccountButton guest appearance={theme} onAppearanceChange={setTheme} onSignIn={() => undefined} />
          </div>
        </Panel>
        <Panel title="Storage">
          <div className="px-gal-stack">
            <StorageMeter usedBytes={3_200_000_000} quotaBytes={50_000_000_000} segments={STORAGE_SEGMENTS} />
            <StorageMeter usedBytes={462_000_000} quotaBytes={500_000_000} segments={[{ id: "projects", label: "Projects", bytes: 300_000_000 }, { id: "recordings", label: "Recordings", bytes: 162_000_000 }]} />
            <StorageMeter usedBytes={500_000_000} quotaBytes={500_000_000} compact />
          </div>
        </Panel>
      </div>
    </Section>
  );
}

const SHORTCUTS: Array<[string, string | { mac: string; other: string }]> = [
  ["Save now", "mod+s"],
  ["Save Version…", "shift+mod+s"],
  ["Version History", "alt+mod+y"],
  ["New Project…", "alt+mod+n"],
  ["Import…", "mod+o"],
  ["Find", "mod+f"],
  ["Go To…", "mod+k"],
  ["Account Settings", "mod+,"],
  ["Toggle Sidebar", { mac: "ctrl+meta+s", other: "ctrl+alt+s" }],
  ["Get Info", "mod+i"],
  ["Restore previewed version", "mod+enter"],
  ["Move to Trash", { mac: "meta+backspace", other: "delete" }],
];

function Keyboard() {
  return (
    <Section id="keyboard" title="Keyboard" lede="Symbols in ⌃⌥⇧⌘ order on a Mac, Ctrl+Alt+Shift+K elsewhere. Browser and accessibility shortcuts are never bound.">
      <Panel>
        <div className="px-gal-shortcuts">
          {SHORTCUTS.map(([label, keys]) => (
            <div key={label} className="px-gal-shortcut">
              <span>{label}</span>
              <KeyboardShortcut keys={keys} />
            </div>
          ))}
        </div>
      </Panel>
    </Section>
  );
}

const RENDERERS: Record<string, () => ReactNode> = {
  colors: () => <Colors />,
  typography: () => <Typography />,
  buttons: () => <Buttons />,
  fields: () => <Fields />,
  toggles: () => <Toggles />,
  segmented: () => <Segmented />,
  menus: () => <Menus />,
  overlays: () => <Overlays />,
  dialogs: () => <Dialogs />,
  feedback: () => <Feedback />,
  media: () => <Media />,
  inspector: () => <InspectorDemo />,
  empty: () => <EmptyStates />,
  account: () => <Account />,
  keyboard: () => <Keyboard />,
};

export function GallerySections({ filter }: { filter: string }) {
  const query = filter.trim().toLocaleLowerCase();
  const visible = GALLERY_SECTIONS.filter((section) => query === "" || section.label.toLocaleLowerCase().includes(query));
  if (visible.length === 0) {
    return <EmptyState icon={SearchIcon} title={`No Results for “${filter.trim()}”`} description="Check the spelling or try a new search." />;
  }
  return (
    <>
      {visible.map((section) => (
        <div key={section.id}>{RENDERERS[section.id]?.()}</div>
      ))}
    </>
  );
}
