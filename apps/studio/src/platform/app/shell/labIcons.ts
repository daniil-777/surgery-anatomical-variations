// The registry names each lab's glyph as a lucide export (core/labs/registry.ts keeps React out of the core); this maps
// the names to components, with a neutral flask for labs added later.

import { Droplet, Droplets, FlaskConical, Layers, PersonStanding, Shapes, SwatchBook, type LucideIcon } from "lucide-react";
import type { LabDefinition } from "../../core/labs/registry";

const LAB_ICONS: Readonly<Record<string, LucideIcon>> = {
  Shapes,
  SwatchBook,
  PersonStanding,
  Layers,
  Droplet,
  Droplets,
};

export function labIcon(name: string): LucideIcon {
  return LAB_ICONS[name] ?? FlaskConical;
}

/** The lab's tint as a CSS colour ("var(--px-lab-organ)"). */
export function labTint(lab: Pick<LabDefinition, "tint">): string {
  return `var(${lab.tint})`;
}
