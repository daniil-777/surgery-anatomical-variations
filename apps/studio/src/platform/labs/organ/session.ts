// The organ lab's saved document, "viscera.atlas-session/1" (DESIGN.md §9). A displayed organ is its committed spec plus
// what re-realizing the spec cannot reproduce: the samplers' provenance (summary.*_model), the sculpture (an attachment,
// sculptCodec.ts), the vessel and photo-detail settings and the view. Everything else regenerates from the spec in the
// browser. The bindings record what the spec was realized against, so a restore can tell an exact replay from a
// drifted one. Documents come back from storage: validation is strict, whitelisted and names the offending path.

import type { JsonValue } from "../../bridge/labSession";

export const ATLAS_SESSION_SCHEMA = "viscera.atlas-session/1";
export const ATLAS_SESSION_SCHEMA_VERSION = 1;
/** The sculpture of every edited organ, one file (sculptCodec.ts). */
export const SCULPT_ATTACHMENT = "sculpt.vsc";
/** Camera values are stored at this resolution so an unchanged view serializes identically (OrbitControls round-trips
 *  its pose through spherical coordinates every frame). */
export const CAMERA_DECIMALS = 6;

export type OrganLabId = "organ" | "texture-lab";
export const ORGAN_LAB_TITLES: Readonly<Record<OrganLabId, string>> = { organ: "Organ Design", "texture-lab": "Texture Lab" };

export type AtlasViewPreset = "front" | "back" | "top" | "oblique";
export type InspectorTab = "shape" | "surface" | "disease" | "sculpt";
export type JointSeverity = "auto" | "mild" | "moderate" | "severe";
export type Vec3 = [number, number, number];
export type JsonRecord = { [key: string]: JsonValue };

export type AtlasSessionCamera = {
  position_mm: Vec3;
  target_mm: Vec3;
  /** Always Y up in the organ viewport; kept for readers of the document. */
  up: Vec3;
  fov_degrees: number;
  near_mm: number;
  far_mm: number;
};

export type AtlasSessionBindings = {
  /** The reference template the spec was realized against (catalog template_sha256). */
  template_sha256: string | null;
  /** SHA-256 of the realized positions and faces (scene.metadata.geometry_sha256). */
  geometry_sha256: string | null;
  realized_id: string | null;
  /** scene.metadata.realized_by.version, or "api" when the VISCERA API realized it. */
  realizer: string;
  catalog_renderer_version: string | null;
  disease_library: { version: string; profile_sha256: string | null } | null;
  material: { version: string; shader_version: string; shader_sha256: string } | null;
  vessels_version: string;
  vertex_count: number;
  triangle_count: number;
};

export type AtlasSessionVessels = { enabled: boolean; seed: number; density: number; visibility: number; radius_scale: number };
/** The texture lab's photo-detail layer (viewer only); null in Organ Design. */
export type AtlasSessionPhoto = { strength: number; relief_mm: number };
export type AtlasSessionView = { preset: AtlasViewPreset; wireframe: boolean; camera: AtlasSessionCamera | null };
export type AtlasSessionSculptOrgan = {
  organ_id: string;
  vertex_count: number;
  /** Vertices whose position differs from the realized surface. */
  changed: number;
  encoding: "sparse" | "dense";
  /** SHA-256 of the realized (float32, little-endian) positions the sculpture was recorded on. */
  base_sha256: string;
};
export type AtlasSessionSculpt = { attachment: string; codec: "vsc1"; organs: AtlasSessionSculptOrgan[] };
export type AtlasSessionTools = {
  inspector_tab: InspectorTab;
  sculpt_radius_mm: number;
  sculpt_stiffness: number;
  variation_strength: number;
  joint_temperature: number;
  joint_severity: JointSeverity;
  match_dimensions: boolean;
};

export type AtlasSessionState = {
  lab: OrganLabId;
  /** The committed generated.spec (binding fields included), as JSON. */
  spec: JsonRecord;
  /** generated.summary entries a re-realization does not reproduce (joint_model, model, disease_model, material_model). */
  provenance: JsonRecord;
  bindings: AtlasSessionBindings;
  vessels: AtlasSessionVessels;
  photo: AtlasSessionPhoto | null;
  view: AtlasSessionView;
  sculpt: AtlasSessionSculpt | null;
  tools?: AtlasSessionTools;
};

export const PROVENANCE_KEYS = ["joint_model", "model", "disease_model", "material_model"] as const;

/** The studio's start-up values (AtlasStudio.tsx state defaults). */
export const DEFAULT_VESSELS: Readonly<AtlasSessionVessels> = { enabled: true, seed: 42, density: 0.5, visibility: 0.65, radius_scale: 1 };
export function defaultPhoto(textureLab: boolean): AtlasSessionPhoto {
  return textureLab ? { strength: 1, relief_mm: 0.03 } : { strength: 0, relief_mm: 0 };
}
export function defaultTools(textureLab: boolean): AtlasSessionTools {
  return {
    inspector_tab: textureLab ? "surface" : "shape",
    sculpt_radius_mm: 35,
    sculpt_stiffness: 0.45,
    variation_strength: 1,
    joint_temperature: 1,
    joint_severity: "auto",
    match_dimensions: false,
  };
}

/** A saved document this lab cannot use; the message is fit for the platform's alert. */
export class OrganSessionError extends Error {
  readonly path: string;
  constructor(message: string, path = "") {
    super(message);
    this.name = "OrganSessionError";
    this.path = path;
  }
}

// --------------------------------------------------------------------------------------------- JSON

const MAX_JSON_DEPTH = 64;
const SHA256 = /^[0-9a-f]{64}$/;
const UINT32_MAX = 4294967295;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === null || Object.getPrototypeOf(proto) === null;
}

/**
 * A deep copy that is exactly JSON: undefined members are dropped (as JSON.stringify does), everything else that JSON
 * cannot carry throws, naming the path. Used on the way out (serialize) so the document is deterministic.
 */
export function toJson(value: unknown, path = "state", depth = 0): JsonValue {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) throw new OrganSessionError(`${path} is not a finite number.`, path);
      if (Number.isInteger(value) && !Number.isSafeInteger(value)) throw new OrganSessionError(`${path} exceeds 2^53.`, path);
      return value;
    case "object": {
      if (depth > MAX_JSON_DEPTH) throw new OrganSessionError(`${path} is nested too deeply.`, path);
      if (Array.isArray(value)) return value.map((item: unknown, index) => (item === undefined ? null : toJson(item, `${path}[${index}]`, depth + 1)));
      if (!isRecord(value)) throw new OrganSessionError(`${path} is not plain data.`, path);
      const copy: JsonRecord = {};
      for (const key of Object.keys(value)) {
        const item = value[key];
        if (item !== undefined) copy[key] = toJson(item, `${path}.${key}`, depth + 1);
      }
      return copy;
    }
    default:
      throw new OrganSessionError(`${path} cannot be stored (${typeof value}).`, path);
  }
}

function toJsonRecord(value: unknown, path: string): JsonRecord {
  const json = toJson(value, path);
  if (!isRecord(json)) throw new OrganSessionError(`${path} must be an object.`, path);
  return json as JsonRecord;
}

// --------------------------------------------------------------------------------------------- validation helpers

function fail(path: string, problem: string): never {
  throw new OrganSessionError(`This saved organ cannot be opened: ${path} ${problem}.`, path);
}

function record(value: unknown, path: string, allowed: readonly string[], required: readonly string[] = allowed): Record<string, unknown> {
  if (!isRecord(value)) fail(path, "is not an object");
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${path}.${key}`, "is not part of this format");
  for (const key of required) if (!(key in value)) fail(`${path}.${key}`, "is missing");
  return value;
}

function finite(value: unknown, path: string, min = -Infinity, max = Infinity): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) fail(path, `must be a number from ${min} to ${max}`);
  return value;
}

function integer(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) fail(path, `must be a whole number from ${min} to ${max}`);
  return value;
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "must be true or false");
  return value;
}

function text(value: unknown, path: string, max = 200): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) fail(path, `must be text of 1 to ${max} characters`);
  return value;
}

function sha(value: unknown, path: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail(path, "must be a SHA-256 (64 lowercase hex digits)");
  return value;
}

function nullable<T>(value: unknown, read: (value: unknown) => T): T | null {
  return value === null ? null : read(value);
}

function oneOf<T extends string>(value: unknown, path: string, options: readonly T[]): T {
  if (typeof value !== "string" || !(options as readonly string[]).includes(value)) fail(path, `must be one of ${options.join(", ")}`);
  return value as T;
}

function vec3(value: unknown, path: string, limit = 1e7): Vec3 {
  if (!Array.isArray(value) || value.length !== 3) fail(path, "must be three numbers");
  return [finite(value[0], `${path}[0]`, -limit, limit), finite(value[1], `${path}[1]`, -limit, limit), finite(value[2], `${path}[2]`, -limit, limit)];
}

function jsonRecord(value: unknown, path: string): JsonRecord {
  if (!isRecord(value)) fail(path, "is not an object");
  try {
    return toJsonRecord(value, path);
  } catch (error) {
    if (error instanceof OrganSessionError) fail(error.path || path, "is not plain JSON");
    throw error;
  }
}

// --------------------------------------------------------------------------------------------- the state

const VIEW_PRESETS: readonly AtlasViewPreset[] = ["front", "back", "top", "oblique"];
const INSPECTOR_TABS: readonly InspectorTab[] = ["shape", "surface", "disease", "sculpt"];
const JOINT_SEVERITIES: readonly JointSeverity[] = ["auto", "mild", "moderate", "severe"];
const APPEARANCES = ["tissue", "clay", "source"] as const;

function readSpec(value: unknown, path: string): JsonRecord {
  const spec = jsonRecord(value, path);
  text(spec.template_id, `${path}.template_id`, 200);
  integer(spec.seed, `${path}.seed`, 0, UINT32_MAX);
  oneOf(spec.appearance, `${path}.appearance`, APPEARANCES);
  const controls = spec.controls;
  if (!isRecord(controls) || Object.keys(controls).length === 0 || Object.keys(controls).length > 64) fail(`${path}.controls`, "must map control names to numbers");
  for (const [key, amount] of Object.entries(controls)) finite(amount, `${path}.controls.${key}`);
  for (const key of ["material", "disease"] as const) {
    const part = spec[key];
    if (part !== undefined && part !== null && !isRecord(part)) fail(`${path}.${key}`, "must be an object or null");
  }
  if (spec.renderer_version !== undefined && spec.renderer_version !== "disease-v2") fail(`${path}.renderer_version`, "is not a renderer this studio knows");
  for (const key of ["template_sha256", "realized_id"] as const) {
    if (spec[key] !== undefined && (typeof spec[key] !== "string" || spec[key].length > 128)) fail(`${path}.${key}`, "must be a short text");
  }
  return spec;
}

function readProvenance(value: unknown, path: string): JsonRecord {
  const provenance = jsonRecord(value, path);
  for (const [key, entry] of Object.entries(provenance)) {
    if (!(PROVENANCE_KEYS as readonly string[]).includes(key)) fail(`${path}.${key}`, "is not a sampler provenance entry");
    if (!isRecord(entry)) fail(`${path}.${key}`, "must be an object");
  }
  return provenance;
}

function readBindings(value: unknown, path: string): AtlasSessionBindings {
  const b = record(value, path, ["template_sha256", "geometry_sha256", "realized_id", "realizer", "catalog_renderer_version", "disease_library", "material", "vessels_version", "vertex_count", "triangle_count"]);
  return {
    template_sha256: nullable(b.template_sha256, (v) => sha(v, `${path}.template_sha256`)),
    geometry_sha256: nullable(b.geometry_sha256, (v) => sha(v, `${path}.geometry_sha256`)),
    realized_id: nullable(b.realized_id, (v) => text(v, `${path}.realized_id`, 128)),
    realizer: text(b.realizer, `${path}.realizer`, 100),
    catalog_renderer_version: nullable(b.catalog_renderer_version, (v) => text(v, `${path}.catalog_renderer_version`, 100)),
    disease_library: nullable(b.disease_library, (v) => {
      const library = record(v, `${path}.disease_library`, ["version", "profile_sha256"]);
      return { version: text(library.version, `${path}.disease_library.version`, 100), profile_sha256: nullable(library.profile_sha256, (s) => sha(s, `${path}.disease_library.profile_sha256`)) };
    }),
    material: nullable(b.material, (v) => {
      const material = record(v, `${path}.material`, ["version", "shader_version", "shader_sha256"]);
      return {
        version: text(material.version, `${path}.material.version`, 100),
        shader_version: text(material.shader_version, `${path}.material.shader_version`, 100),
        shader_sha256: sha(material.shader_sha256, `${path}.material.shader_sha256`),
      };
    }),
    vessels_version: text(b.vessels_version, `${path}.vessels_version`, 100),
    vertex_count: integer(b.vertex_count, `${path}.vertex_count`, 0, 2 ** 31),
    triangle_count: integer(b.triangle_count, `${path}.triangle_count`, 0, 2 ** 31),
  };
}

function readVessels(value: unknown, path: string): AtlasSessionVessels {
  const v = record(value, path, ["enabled", "seed", "density", "visibility", "radius_scale"]);
  return {
    enabled: bool(v.enabled, `${path}.enabled`),
    seed: integer(v.seed, `${path}.seed`, 0, UINT32_MAX),
    density: finite(v.density, `${path}.density`, 0, 1),
    visibility: finite(v.visibility, `${path}.visibility`, 0, 1),
    radius_scale: finite(v.radius_scale, `${path}.radius_scale`, 0.05, 5),
  };
}

function readPhoto(value: unknown, path: string): AtlasSessionPhoto {
  const p = record(value, path, ["strength", "relief_mm"]);
  return { strength: finite(p.strength, `${path}.strength`, 0, 2), relief_mm: finite(p.relief_mm, `${path}.relief_mm`, 0, 0.12) };
}

export function readCamera(value: unknown, path = "camera"): AtlasSessionCamera {
  const c = record(value, path, ["position_mm", "target_mm", "up", "fov_degrees", "near_mm", "far_mm"]);
  const camera: AtlasSessionCamera = {
    position_mm: vec3(c.position_mm, `${path}.position_mm`),
    target_mm: vec3(c.target_mm, `${path}.target_mm`),
    up: vec3(c.up, `${path}.up`, 2),
    fov_degrees: finite(c.fov_degrees, `${path}.fov_degrees`, 1, 179),
    near_mm: finite(c.near_mm, `${path}.near_mm`, 1e-9, 1e9),
    far_mm: finite(c.far_mm, `${path}.far_mm`, 1e-9, 1e12),
  };
  if (camera.far_mm <= camera.near_mm) fail(`${path}.far_mm`, "must lie beyond near_mm");
  const [px, py, pz] = camera.position_mm, [tx, ty, tz] = camera.target_mm;
  if (px === tx && py === ty && pz === tz) fail(`${path}.position_mm`, "must differ from the target");
  return camera;
}

function readView(value: unknown, path: string): AtlasSessionView {
  const v = record(value, path, ["preset", "wireframe", "camera"]);
  return {
    preset: oneOf(v.preset, `${path}.preset`, VIEW_PRESETS),
    wireframe: bool(v.wireframe, `${path}.wireframe`),
    camera: nullable(v.camera, (c) => readCamera(c, `${path}.camera`)),
  };
}

function readSculpt(value: unknown, path: string): AtlasSessionSculpt {
  const s = record(value, path, ["attachment", "codec", "organs"]);
  if (s.attachment !== SCULPT_ATTACHMENT) fail(`${path}.attachment`, `must be "${SCULPT_ATTACHMENT}"`);
  if (s.codec !== "vsc1") fail(`${path}.codec`, 'must be "vsc1"');
  if (!Array.isArray(s.organs) || s.organs.length === 0 || s.organs.length > 64) fail(`${path}.organs`, "must list 1 to 64 organs");
  const seen = new Set<string>();
  const organs = s.organs.map((entry: unknown, index): AtlasSessionSculptOrgan => {
    const at = `${path}.organs[${index}]`;
    const o = record(entry, at, ["organ_id", "vertex_count", "changed", "encoding", "base_sha256"]);
    const organId = text(o.organ_id, `${at}.organ_id`, 128);
    if (seen.has(organId)) fail(`${at}.organ_id`, "repeats another organ");
    seen.add(organId);
    const vertexCount = integer(o.vertex_count, `${at}.vertex_count`, 1, 2 ** 26);
    return {
      organ_id: organId,
      vertex_count: vertexCount,
      changed: integer(o.changed, `${at}.changed`, 0, vertexCount),
      encoding: oneOf(o.encoding, `${at}.encoding`, ["sparse", "dense"] as const),
      base_sha256: sha(o.base_sha256, `${at}.base_sha256`),
    };
  });
  return { attachment: SCULPT_ATTACHMENT, codec: "vsc1", organs };
}

function readTools(value: unknown, path: string): AtlasSessionTools {
  const t = record(value, path, ["inspector_tab", "sculpt_radius_mm", "sculpt_stiffness", "variation_strength", "joint_temperature", "joint_severity", "match_dimensions"]);
  return {
    inspector_tab: oneOf(t.inspector_tab, `${path}.inspector_tab`, INSPECTOR_TABS),
    sculpt_radius_mm: finite(t.sculpt_radius_mm, `${path}.sculpt_radius_mm`, 1, 500),
    sculpt_stiffness: finite(t.sculpt_stiffness, `${path}.sculpt_stiffness`, 0, 1),
    variation_strength: finite(t.variation_strength, `${path}.variation_strength`, 0, 1),
    joint_temperature: finite(t.joint_temperature, `${path}.joint_temperature`, 0.01, 10),
    joint_severity: oneOf(t.joint_severity, `${path}.joint_severity`, JOINT_SEVERITIES),
    match_dimensions: bool(t.match_dimensions, `${path}.match_dimensions`),
  };
}

/** The state of a saved organ, checked field by field (unknown fields are refused, not ignored). */
export function readAtlasSessionState(value: unknown, path = "state"): AtlasSessionState {
  const s = record(value, path, ["lab", "spec", "provenance", "bindings", "vessels", "photo", "view", "sculpt", "tools"], ["lab", "spec", "provenance", "bindings", "vessels", "photo", "view", "sculpt"]);
  const lab = oneOf(s.lab, `${path}.lab`, ["organ", "texture-lab"] as const);
  const state: AtlasSessionState = {
    lab,
    spec: readSpec(s.spec, `${path}.spec`),
    provenance: readProvenance(s.provenance, `${path}.provenance`),
    bindings: readBindings(s.bindings, `${path}.bindings`),
    vessels: readVessels(s.vessels, `${path}.vessels`),
    photo: nullable(s.photo, (p) => readPhoto(p, `${path}.photo`)),
    view: readView(s.view, `${path}.view`),
    sculpt: nullable(s.sculpt, (v) => readSculpt(v, `${path}.sculpt`)),
  };
  if (s.tools !== undefined) state.tools = readTools(s.tools, `${path}.tools`);
  return state;
}

/** The schema version of a document id ("viscera.atlas-session/1" → 1), or null for another format. */
export function atlasSessionSchemaVersion(schema: unknown): number | null {
  if (typeof schema !== "string") return null;
  const match = /^viscera\.atlas-session\/([1-9][0-9]{0,5})$/.exec(schema);
  return match ? Number(match[1]) : null;
}

/** Checks a saved document's header and state for this lab and returns the typed state. */
export function readAtlasSessionDocument(document: { schema: unknown; labId: unknown; state: unknown }, labId: OrganLabId): AtlasSessionState {
  const version = atlasSessionSchemaVersion(document.schema);
  if (version === null) throw new OrganSessionError("This saved version does not belong to Organ Design or the Texture Lab.", "schema");
  if (version > ATLAS_SESSION_SCHEMA_VERSION) {
    throw new OrganSessionError("This version was saved by a newer release of VISCERA. Reload the page to open it.", "schema");
  }
  if (document.labId !== labId) throw new OrganSessionError(`This saved version belongs to another lab (${String(document.labId)}).`, "labId");
  const state = readAtlasSessionState(document.state);
  if (state.lab !== labId) throw new OrganSessionError(`This saved version belongs to another lab (${state.lab}).`, "state.lab");
  return state;
}

/** Rounds a camera to the stored resolution (see CAMERA_DECIMALS). */
export function roundCamera(camera: AtlasSessionCamera): AtlasSessionCamera {
  const round = (value: number) => {
    const rounded = Number(value.toFixed(CAMERA_DECIMALS));
    return Object.is(rounded, -0) ? 0 : rounded;
  };
  const triple = (v: Vec3): Vec3 => [round(v[0]), round(v[1]), round(v[2])];
  return {
    position_mm: triple(camera.position_mm),
    target_mm: triple(camera.target_mm),
    up: triple(camera.up),
    fov_degrees: round(camera.fov_degrees),
    near_mm: camera.near_mm,
    far_mm: camera.far_mm,
  };
}

/** Largest absolute difference between two cameras' positions and targets (mm). */
export function cameraDistance(a: AtlasSessionCamera, b: AtlasSessionCamera): number {
  let max = Math.abs(a.fov_degrees - b.fov_degrees);
  for (let i = 0; i < 3; i++) {
    max = Math.max(max, Math.abs(a.position_mm[i]! - b.position_mm[i]!), Math.abs(a.target_mm[i]! - b.target_mm[i]!));
  }
  return max;
}

export { toJsonRecord };
