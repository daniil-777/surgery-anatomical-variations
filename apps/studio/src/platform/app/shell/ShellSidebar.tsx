// The shell's sidebar (APPLE_STYLE_SPEC §2.2): Home and Projects, the Library and Imports scopes, the labs, the Trash,
// and the account row. Counts come from the account's usage (one request), as plain trailing numbers like Mail.

import { useMemo } from "react";
import { Blend, Box, Cuboid, FolderClosed, Heart, House, Images, Import, Package, Palette, Trash2, Video } from "lucide-react";
import { listLabs } from "../../core/labs/registry";
import { SIDEBAR_SHORTCUT, Sidebar, SidebarBrand, SidebarItem, SidebarSection, SidebarToggle, useAppLayout } from "../../ui";
import { formatRoute, type Route } from "../router";
import { AccountFooter } from "./AccountFooter";
import { labIcon, labTint } from "./labIcons";
import { useUsage } from "./queries";
import { isSidebarCurrent } from "./routeMeta";
import "./styles/shell.css";

export interface ShellSidebarProps {
  route: Route;
  onKeyboardShortcuts: () => void;
}

/** A count worth showing: zero reads as nothing, like Mail. */
function count(value: number | undefined): number | undefined {
  return value !== undefined && value > 0 ? value : undefined;
}

export function ShellSidebar({ route, onKeyboardShortcuts }: ShellSidebarProps) {
  const layout = useAppLayout();
  const usage = useUsage().data;
  const labs = useMemo(() => listLabs(), []);
  const toggle = layout ? <SidebarToggle hidden={layout.sidebarHidden} onToggle={layout.toggleSidebar} shortcut={SIDEBAR_SHORTCUT} /> : null;
  // in the overlay (narrow windows) choosing a row also closes the sidebar
  const closeOverlay = layout?.overlay ? () => layout.setSidebarHidden(true) : undefined;

  return (
    <Sidebar header={<SidebarBrand href="#/" trailing={toggle} />} footer={<AccountFooter onKeyboardShortcuts={onKeyboardShortcuts} />}>
      <SidebarSection>
        <SidebarItem label="Home" icon={House} href={formatRoute({ name: "home" })} current={isSidebarCurrent(route, { name: "home" })} onSelect={closeOverlay} />
        <SidebarItem
          label="Projects"
          icon={FolderClosed}
          href={formatRoute({ name: "projects" })}
          current={isSidebarCurrent(route, { name: "projects" })}
          count={count(usage?.projectCount)}
          onSelect={closeOverlay}
        />
      </SidebarSection>
      <SidebarSection title="Library" collapsible>
        <SidebarItem
          label="All Items"
          icon={Images}
          href={formatRoute({ name: "library" })}
          current={isSidebarCurrent(route, { name: "library" })}
          count={count(usage?.libraryCount)}
          onSelect={closeOverlay}
        />
        <SidebarItem label="Shapes" icon={Cuboid} href={formatRoute({ name: "library", filter: "shape" })} current={isSidebarCurrent(route, { name: "library", filter: "shape" })} onSelect={closeOverlay} />
        <SidebarItem label="Materials" icon={Palette} href={formatRoute({ name: "library", filter: "material" })} current={isSidebarCurrent(route, { name: "library", filter: "material" })} onSelect={closeOverlay} />
        <SidebarItem label="Recordings" icon={Video} href={formatRoute({ name: "library", filter: "recording" })} current={isSidebarCurrent(route, { name: "library", filter: "recording" })} onSelect={closeOverlay} />
        <SidebarItem label="Favorites" icon={Heart} href={formatRoute({ name: "library", filter: "favorites" })} current={isSidebarCurrent(route, { name: "library", filter: "favorites" })} onSelect={closeOverlay} />
      </SidebarSection>
      <SidebarSection title="Imports" collapsible>
        <SidebarItem
          label="All Imports"
          icon={Import}
          href={formatRoute({ name: "imports" })}
          current={isSidebarCurrent(route, { name: "imports" })}
          count={count(usage?.importCount)}
          onSelect={closeOverlay}
        />
        <SidebarItem label="Unity" icon={Box} href={formatRoute({ name: "imports", source: "unity" })} current={isSidebarCurrent(route, { name: "imports", source: "unity" })} onSelect={closeOverlay} />
        <SidebarItem label="Blender" icon={Blend} href={formatRoute({ name: "imports", source: "blender" })} current={isSidebarCurrent(route, { name: "imports", source: "blender" })} onSelect={closeOverlay} />
        <SidebarItem label="Other Apps" icon={Package} href={formatRoute({ name: "imports", source: "other" })} current={isSidebarCurrent(route, { name: "imports", source: "other" })} onSelect={closeOverlay} />
      </SidebarSection>
      <SidebarSection title="Labs" collapsible>
        {labs.map((lab) => (
          <SidebarItem key={lab.id} label={lab.title} icon={labIcon(lab.icon)} tint={labTint(lab)} href={formatRoute({ name: "lab", labId: lab.id })} />
        ))}
      </SidebarSection>
      <div className="px-shell-sidebar-end">
        <SidebarSection>
          <SidebarItem label="Trash" icon={Trash2} href={formatRoute({ name: "trash" })} current={isSidebarCurrent(route, { name: "trash" })} count={count(usage?.trashCount)} onSelect={closeOverlay} />
        </SidebarSection>
      </div>
    </Sidebar>
  );
}
