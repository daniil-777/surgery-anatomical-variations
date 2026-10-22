// Development gallery for the px UI kit (apps/studio/px-gallery.html, served by the Vite dev server only; it is not a
// build input). Every component in every state, inside a window built from the kit itself, with a theme switcher.

import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Atom,
  Box,
  Droplet,
  Droplets,
  FolderClosed,
  History,
  House,
  Images,
  Import,
  Layers,
  PanelRight,
  Plus,
  Shapes,
} from "lucide-react";
import {
  AccountButton,
  AppLayout,
  Button,
  IconButton,
  Inspector,
  InspectorRow,
  InspectorSection,
  MenuButton,
  MenuItem,
  PxProvider,
  SearchField,
  SegmentedControl,
  Sidebar,
  SidebarBrand,
  SidebarItem,
  SidebarSection,
  SidebarToggle,
  StorageMeter,
  Switch,
  Toolbar,
  ToolbarGroup,
  ToolbarItem,
  formatCount,
  useAppLayout,
  usePx,
  useShortcuts,
  type PxGlass,
  type PxTheme,
} from "../index";
import { GALLERY_SECTIONS, GallerySections } from "./sections";
import { THUMBS } from "./thumbs";
import "./gallery.css";

const GROUPS = ["Foundations", "Controls", "Overlays", "Content"] as const;

function useCurrentSection(): [string, (id: string) => void] {
  const [current, setCurrent] = useState(GALLERY_SECTIONS[0]?.id ?? "");
  useEffect(() => {
    const root = document.getElementById("px-main");
    if (!root || typeof IntersectionObserver === "undefined") return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        const first = visible[0];
        if (first) setCurrent(first.target.id);
      },
      { root, rootMargin: "-60px 0px -65% 0px" },
    );
    for (const section of GALLERY_SECTIONS) {
      const element = document.getElementById(section.id);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, []);
  return [current, setCurrent];
}

function GallerySidebar({ current, onNavigate }: { current: string; onNavigate: (id: string) => void }) {
  const layout = useAppLayout();
  const { appearance, setAppearance } = usePx();
  return (
    <Sidebar
      header={
        <SidebarBrand
          href="#colors"
          trailing={layout ? <SidebarToggle hidden={layout.sidebarHidden} onToggle={layout.toggleSidebar} shortcut={{ mac: "ctrl+meta+s", other: "ctrl+alt+s" }} /> : null}
        />
      }
      footer={
        <AccountButton
          name="Daniil Emtsev"
          email="daniil@example.com"
          subtitle="Pro · 3.2 of 50 GB"
          sync="synced"
          appearance={appearance.theme}
          onAppearanceChange={(theme) => setAppearance({ theme })}
          onAccountSettings={() => undefined}
          onStorage={() => undefined}
          onKeyboardShortcuts={() => undefined}
          onHelp={() => undefined}
          onSignOut={() => undefined}
        />
      }
    >
      {GROUPS.map((group) => (
        <SidebarSection key={group} title={group} collapsible>
          {GALLERY_SECTIONS.filter((section) => section.group === group).map((section) => (
            <SidebarItem
              key={section.id}
              label={section.label}
              icon={section.icon}
              href={`#${section.id}`}
              current={current === section.id}
              onSelect={() => onNavigate(section.id)}
            />
          ))}
        </SidebarSection>
      ))}
      <SidebarSection title="Sample Navigation" collapsible>
        <SidebarItem label="Home" icon={House} href="#account" />
        <SidebarItem label="Projects" icon={FolderClosed} count={24} href="#media" />
        <SidebarItem label="Library" icon={Images} count={new Intl.NumberFormat("en-US").format(1284)} href="#media" dropTarget />
        <SidebarItem label="Imports" icon={Import} count={37} href="#empty" />
        <SidebarItem label="Organ Lab" icon={Shapes} tint="var(--px-lab-organ)" href="#media" defaultExpanded>
          <SidebarItem label="Liver Capsule Study" href="#media" />
          <SidebarItem label="Colon Mucosa Walkthrough" href="#media" />
        </SidebarItem>
        <SidebarItem label="Tissue Lab" icon={Layers} tint="var(--px-lab-tissue)" href="#media">
          <SidebarItem label="Wet Coat 4K" href="#media" />
        </SidebarItem>
        <SidebarItem label="Fat Lab" icon={Droplet} tint="var(--px-lab-fat)" href="#media" />
        <SidebarItem label="Blood Lab" icon={Droplets} tint="var(--px-lab-blood)" href="#media" />
        <SidebarItem label="Physics Lab" icon={Atom} tint="var(--px-lab-physics)" disabled />
      </SidebarSection>
    </Sidebar>
  );
}

function AppearanceInspector() {
  const { appearance, setAppearance, colorScheme, isMac, reducedMotion, route } = usePx();
  return (
    <Inspector
      title="Appearance"
      preview={<img src={THUMBS.liver} alt="" />}
      footer={
        <Button variant="bordered" onClick={() => setAppearance({ theme: "system", glass: "regular", transparency: "system" })}>
          Reset Appearance
        </Button>
      }
    >
      <InspectorSection title="Theme" persistKey="gallery-theme">
        <SegmentedControl<PxTheme>
          aria-label="Appearance"
          fullWidth
          value={appearance.theme}
          onChange={(theme) => setAppearance({ theme })}
          items={[
            { value: "system", label: "System" },
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ]}
        />
        <SegmentedControl<PxGlass>
          aria-label="Glass"
          fullWidth
          value={appearance.glass}
          onChange={(glass) => setAppearance({ glass })}
          items={[
            { value: "clear", label: "Clear" },
            { value: "regular", label: "Regular" },
            { value: "tinted", label: "Tinted" },
          ]}
        />
        <Switch
          label="Reduce Transparency"
          size="small"
          checked={appearance.transparency === "reduce"}
          onChange={(event) => setAppearance({ transparency: event.target.checked ? "reduce" : "system" })}
        />
      </InspectorSection>
      <InspectorSection title="Environment" persistKey="gallery-environment">
        <InspectorRow label="Color scheme">{colorScheme === "dark" ? "Dark" : "Light"}</InspectorRow>
        <InspectorRow label="Route">{route}</InspectorRow>
        <InspectorRow label="Shortcuts">{isMac ? "⌘ (Apple)" : "Ctrl"}</InspectorRow>
        <InspectorRow label="Reduce Motion">{reducedMotion ? "On" : "Off"}</InspectorRow>
      </InspectorSection>
      <InspectorSection title="Storage" persistKey="gallery-storage">
        <StorageMeter usedBytes={3_200_000_000} quotaBytes={50_000_000_000} compact />
      </InspectorSection>
    </Inspector>
  );
}

function GalleryApp() {
  const { appearance, setAppearance } = usePx();
  // §2.1: the inspector is a column (shown by default) from 1280 px, a floating panel (hidden by default) below
  const [inspectorShown, setInspectorShown] = useState(() => window.matchMedia("(min-width: 1280px)").matches);
  const [filter, setFilter] = useState("");
  const [current, setCurrent] = useCurrentSection();

  useShortcuts([{ keys: "mod+i", handler: () => setInspectorShown((shown) => !shown) }]);

  return (
    <AppLayout
      sidebar={<GallerySidebar current={current} onNavigate={setCurrent} />}
      inspector={<AppearanceInspector />}
      inspectorShown={inspectorShown}
      toolbar={
        <Toolbar
          title="Components"
          subtitle={formatCount(GALLERY_SECTIONS.length, "Section")}
          centerPriority={2}
          center={
            <SegmentedControl<PxTheme>
              aria-label="Theme"
              variant="toolbar"
              value={appearance.theme}
              onChange={(theme) => setAppearance({ theme })}
              items={[
                { value: "system", label: "System" },
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
              ]}
            />
          }
          trailing={
            <>
              <ToolbarGroup aria-label="History" priority={3}>
                <IconButton icon={History} label="Version History" shortcut="alt+mod+y" variant="toolbar" size="toolbar" />
                <IconButton icon={Box} label="Imports" variant="toolbar" size="toolbar" />
              </ToolbarGroup>
              <ToolbarItem priority={2}>
                <SearchField label="Search Components" variant="toolbar" value={filter} onChange={setFilter} focusShortcut="mod+f" />
              </ToolbarItem>
              <ToolbarGroup>
                <IconButton
                  icon={PanelRight}
                  label={inspectorShown ? "Hide Inspector" : "Show Inspector"}
                  shortcut="mod+i"
                  variant="toolbar"
                  size="toolbar"
                  pressed={inspectorShown}
                  onClick={() => setInspectorShown(!inspectorShown)}
                />
              </ToolbarGroup>
              <MenuButton
                variant="borderedProminent"
                size="toolbar"
                icon={Plus}
                placement="bottom-end"
                className="px-gal-hide-narrow"
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
            </>
          }
        />
      }
    >
      <div className="px-gal">
        <header className="px-gal-hero">
          <p className="px-gal-hero__eyebrow">VISCERA Account Platform</p>
          <p className="px-large-title px-em">Interface Kit</p>
          <p className="px-gal-hero__lede">
            Apple-style components for the account shell: macOS density, Light and Dark, Liquid Glass only on the functional layer, keyboard first.
          </p>
        </header>
        <GallerySections filter={filter} />
      </div>
    </AppLayout>
  );
}

/** ?theme=light|dark|system for screenshots and reviews. */
function ThemeFromQuery() {
  const { setAppearance } = usePx();
  useEffect(() => {
    const theme = new URLSearchParams(window.location.search).get("theme");
    if (theme === "light" || theme === "dark" || theme === "system") setAppearance({ theme });
  }, [setAppearance]);
  return null;
}

const container = document.getElementById("px-gallery-root");
if (!container) throw new Error("px-gallery.html is missing #px-gallery-root");
createRoot(container).render(
  <StrictMode>
    <PxProvider route="app">
      <ThemeFromQuery />
      <GalleryApp />
    </PxProvider>
  </StrictMode>,
);
