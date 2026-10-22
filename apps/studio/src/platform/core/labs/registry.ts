// The labs the account platform can open. A lab is a studio mode loaded in a same-origin iframe
// ("./?mode=<mode>&embed=1&lab=<id>", relative to the site base); its registry id is what projects.lab_id stores.
// Labs still being built in their own working tree (Tissue, Fat, Blood) are declared as "planned": hidden from every
// list unless explicitly enabled, so adopting one later is a one-entry change here and nothing else in the platform.
// The development test lab (px-test-lab.html, used by the editor's end-to-end tests) exists only in development
// builds: import.meta.env.DEV is false in production, so its entry is not even in the bundle.

import type { LibraryKind } from "../types";

/** Same rule as projects.lab_id in the database. */
export const LAB_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

export type LabCategory = "anatomy" | "materials" | "scene" | "simulation";
export type LabAvailability = "available" | "planned";

export interface LabCapabilities {
  /** The lab registers a session adapter: projects autosave, version and restore. */
  readonly projects: boolean;
  /** "Record" (canvas video) works from the project bar. */
  readonly recording: boolean;
  /** A still image of the viewport can be added to the library. */
  readonly screenshot: boolean;
  /** Library kinds the lab can produce. */
  readonly library: readonly LibraryKind[];
}

export interface LabDefinition {
  readonly id: string;
  /** The studio's ?mode= value. */
  readonly mode: string;
  readonly title: string;
  /** One factual sentence for tiles and menus (no claims the lab itself does not make). */
  readonly description: string;
  /** A lucide-react export name. */
  readonly icon: string;
  /** The CSS custom property that tints the lab glyph. */
  readonly tint: string;
  readonly category: LabCategory;
  readonly availability: LabAvailability;
  readonly capabilities: LabCapabilities;
  /** Other modes that show this lab (switched in place by the studio). */
  readonly aliases: readonly string[];
  /** Standalone entry pages of this lab (the site builds them from index.html with a viscera-mode meta tag). */
  readonly pages: readonly string[];
  /** A page the frame opens instead of the studio's "./?mode=…" (a lab with its own document, e.g. the test lab). */
  readonly entry?: string;
}

const STUDIO_LABS: readonly LabDefinition[] = [
  {
    id: "organ",
    mode: "atlas",
    title: "Organ Design",
    description: "Generate, vary and sculpt organ shapes.",
    icon: "Shapes",
    tint: "--px-lab-organ",
    category: "anatomy",
    availability: "available",
    capabilities: { projects: true, recording: true, screenshot: true, library: ["shape", "material", "recording", "image"] },
    aliases: [],
    pages: [],
  },
  {
    id: "texture-lab",
    mode: "textures",
    title: "Texture Lab",
    description: "Organ surfaces with detail from licensed surgical photographs.",
    icon: "SwatchBook",
    tint: "--px-lab-tissue",
    category: "materials",
    availability: "available",
    capabilities: { projects: true, recording: true, screenshot: true, library: ["shape", "texture", "recording", "image"] },
    aliases: [],
    pages: ["textures.html"],
  },
  {
    id: "scene",
    mode: "scene",
    title: "Whole Body",
    description: "The whole anatomy scene: explore, record and capture.",
    icon: "PersonStanding",
    tint: "--px-lab-physics",
    category: "scene",
    availability: "available",
    capabilities: { projects: false, recording: true, screenshot: true, library: ["recording", "image"] },
    aliases: ["textures-scene"],
    pages: [],
  },
  {
    id: "tissue",
    mode: "tissues",
    title: "Tissue Lab",
    description: "Surface materials, endoscope walkthroughs, 4K capture.",
    icon: "Layers",
    tint: "--px-lab-tissue",
    category: "materials",
    availability: "planned",
    capabilities: { projects: false, recording: true, screenshot: true, library: ["material", "texture", "recording", "image"] },
    aliases: [],
    pages: ["tissues.html"],
  },
  {
    id: "fat",
    mode: "fat",
    title: "Fat Lab",
    description: "Adipose shape, texture and mechanics.",
    icon: "Droplet",
    tint: "--px-lab-fat",
    category: "anatomy",
    availability: "planned",
    capabilities: { projects: false, recording: true, screenshot: true, library: ["shape", "material", "recording", "image"] },
    aliases: [],
    pages: ["fat.html"],
  },
  {
    id: "blood",
    mode: "blood",
    title: "Blood Lab",
    description: "Bleeding, vessels and optics.",
    icon: "Droplets",
    tint: "--px-lab-blood",
    category: "simulation",
    availability: "planned",
    capabilities: { projects: false, recording: true, screenshot: true, library: ["recording", "image"] },
    aliases: [],
    pages: [],
  },
];

/** The development test lab: a counter, a note, attachments, busy switches, exports and a canvas (devlab/). */
export const TEST_LAB: LabDefinition = {
  id: "test-lab",
  mode: "test-lab",
  title: "Test Lab",
  description: "A development lab for end-to-end tests: a counter, a note, attachments and a canvas.",
  icon: "FlaskConical",
  tint: "--px-lab-physics",
  category: "simulation",
  availability: "available",
  capabilities: { projects: true, recording: true, screenshot: true, library: ["image", "shape"] },
  aliases: [],
  pages: ["px-test-lab.html"],
  entry: "px-test-lab.html",
};

export const LABS: readonly LabDefinition[] = import.meta.env.DEV ? [...STUDIO_LABS, TEST_LAB] : STUDIO_LABS;

export interface LabListOptions {
  /** Ids of planned labs to show anyway (e.g. from platform.json while a lab is being adopted). */
  enabled?: Iterable<string> | undefined;
}

function enabledSet(enabled: Iterable<string> | undefined): ReadonlySet<string> {
  return new Set(enabled ?? []);
}

export function isLabVisible(lab: LabDefinition, options: LabListOptions = {}): boolean {
  return lab.availability === "available" || enabledSet(options.enabled).has(lab.id);
}

/** Labs to show in the UI: every available lab plus explicitly enabled planned ones, in registry order. */
export function listLabs(options: LabListOptions = {}): LabDefinition[] {
  const enabled = enabledSet(options.enabled);
  return LABS.filter((lab) => lab.availability === "available" || enabled.has(lab.id));
}

/** Any declared lab, planned ones included (an existing project still needs its lab's name and glyph). */
export function getLab(id: string): LabDefinition | null {
  return LABS.find((lab) => lab.id === id) ?? null;
}

/** The lab a studio mode belongs to. A missing or empty mode is the studio default, Organ Design. */
export function labForMode(mode: string | null | undefined): LabDefinition | null {
  const value = (mode ?? "").trim().toLowerCase();
  if (value === "") return getLab("organ");
  return LABS.find((lab) => lab.mode === value || lab.aliases.includes(value)) ?? null;
}

/** The lab whose standalone entry page this path ends with (e.g. "/anatomy/textures.html"). */
export function labForPage(pathname: string): LabDefinition | null {
  const page = pathname.slice(pathname.lastIndexOf("/") + 1).toLowerCase();
  if (page === "") return null;
  return LABS.find((lab) => lab.pages.includes(page)) ?? null;
}

export interface LabUrlOptions {
  /** Resolve against this base (the site root); without it the URL stays relative ("./?…"). */
  base?: string | URL | undefined;
  /**
   * The lab is about to receive a stored document (opening or restoring a project): "&restore=pending" tells it to
   * skip its default generation (DESIGN.md §15.6).
   */
  restorePending?: boolean | undefined;
  /** Extra query parameters (e.g. template); undefined and null values are skipped. */
  params?: Readonly<Record<string, string | null | undefined>> | undefined;
  /** The same as params. */
  extra?: Readonly<Record<string, string | null | undefined>> | undefined;
}

const RESERVED_PARAMS = new Set(["mode", "embed", "lab", "restore"]);

/**
 * "./?mode=<mode>&embed=1&lab=<id>[&restore=pending]" — the URL a lab iframe opens ("./<entry>?embed=1&lab=<id>…" for a
 * lab with its own page).
 */
export function labUrl(lab: LabDefinition | string, options: LabUrlOptions = {}): string {
  const definition = typeof lab === "string" ? getLab(lab) : lab;
  if (!definition) throw new Error(`Unknown lab "${String(lab)}".`);
  const query = new URLSearchParams(
    definition.entry === undefined ? { mode: definition.mode, embed: "1", lab: definition.id } : { embed: "1", lab: definition.id },
  );
  if (options.restorePending) query.set("restore", "pending");
  for (const [key, value] of Object.entries({ ...options.params, ...options.extra })) {
    if (value === undefined || value === null) continue;
    if (RESERVED_PARAMS.has(key)) continue;
    query.set(key, value);
  }
  const relative = `./${definition.entry ?? ""}?${query.toString()}`;
  return options.base === undefined ? relative : new URL(relative, options.base).href;
}

/**
 * The registry id a URL opens: the explicit lab parameter (when it names a declared lab), else its mode, else its
 * entry page. Null for URLs that are not labs (the platform shell itself, other pages).
 */
export function labIdFromUrl(url: string | URL, base?: string | URL): string | null {
  let parsed: URL;
  try {
    parsed = typeof url === "string" ? new URL(url, base) : url;
  } catch {
    return null;
  }
  const explicit = parsed.searchParams.get("lab");
  if (explicit !== null && getLab(explicit)) return explicit;
  const mode = parsed.searchParams.get("mode");
  if (mode !== null) return labForMode(mode)?.id ?? null;
  return labForPage(parsed.pathname)?.id ?? null;
}
