// The organ lab's session adapter: the lab side of platform/bridge/labSession.ts for Organ Design (?mode=atlas) and the
// Texture Lab (?mode=textures). It is pure logic over an OrganStudioPort, which useOrganLabSession.ts implements on the
// studio's React state, so every rule here runs in node tests against a fake studio.
//
// Restore follows the order the studio's own code requires (atlas-design (e)): the catalog first; the bindings checked
// against it before anything changes; quiesce (previews, requests, sculpt mode) and clear the sculpture in its ref and
// state, or generate() refuses a different shape; viewer settings; generate() with the saved spec minus its realized_id
// (the one realize path, API or browser); the stored provenance merged into a new summary (the committed generation can
// be the shared cached reference); the sculpture, validated against the regenerated surface, after that commit; then,
// once the viewport has mounted the result, the camera.

import type { SceneData } from "@viscera/render";
import type { LabExportAction, LabLibraryExport, LabRestoreReport, LabSessionAdapter, LabSessionDocument } from "../../bridge/labSession";
import type { AtlasCatalog, AtlasGeneration, AtlasOrgan, AtlasSpec, AtlasTemplate } from "../../../atlas";
import { ATLAS_MATERIAL_SHADER_SHA256, ATLAS_MATERIAL_SHADER_VERSION } from "../../../atlasMaterialShader";
import type { SurfaceEdit } from "../../../atlasSculptHistory";
import { ATLAS_VESSEL_VERSION } from "../../../atlasVessels";
import type { PhotoTileInfo } from "../../../photoDetail";
import { SculptCodecError, encodeSculpt, parseSculpt, positionsSha256, sculptPositions, type ParsedSculptOrgan } from "./sculptCodec";
import {
  ATLAS_SESSION_SCHEMA,
  ORGAN_LAB_TITLES,
  OrganSessionError,
  PROVENANCE_KEYS,
  SCULPT_ATTACHMENT,
  defaultPhoto,
  readAtlasSessionDocument,
  roundCamera,
  toJson,
  toJsonRecord,
  type AtlasSessionBindings,
  type AtlasSessionCamera,
  type AtlasSessionPhoto,
  type AtlasSessionSculpt,
  type AtlasSessionState,
  type AtlasSessionTools,
  type AtlasSessionVessels,
  type AtlasViewPreset,
  type JsonRecord,
  type OrganLabId,
} from "./session";

/** What the studio shows right now (the committed generation, never an unapplied draft). */
export interface OrganCurrentState {
  catalog: AtlasCatalog;
  generation: AtlasGeneration;
  /** The sculpt history's present: absolute positions per edited organ. */
  sculpt: readonly SurfaceEdit[];
  /** The scene as displayed: vessels and sculpture applied (null while the vessel network is being built). */
  displayedScene: SceneData | null;
  vessels: AtlasSessionVessels;
  /** The texture lab's photo-detail layer (null in Organ Design). */
  photo: AtlasSessionPhoto | null;
  view: { preset: AtlasViewPreset; wireframe: boolean };
  tools: AtlasSessionTools;
  /** The photograph behind the texture lab's photo layer (its credit travels with exports). */
  photoTile: PhotoTileInfo | null;
}

export interface OrganRestoreSettings {
  vessels: AtlasSessionVessels;
  photo: AtlasSessionPhoto | null;
  view: { preset: AtlasViewPreset; wireframe: boolean };
  tools: AtlasSessionTools | null;
}

/** The studio operations the adapter needs; useOrganLabSession.ts implements them on AtlasStudio's state. */
export interface OrganStudioPort {
  readonly labId: OrganLabId;
  readonly textureLab: boolean;
  current(): OrganCurrentState | null;
  /** The studio's own reason not to save or capture now (loading, generating, exporting, a model switch, a drag). */
  studioBusy(): false | string;
  /** Opened with restore=pending and still waiting for restore() or startFresh(). */
  pending(): boolean;
  /** The anatomy catalog once loaded; rejects when its load failed or the signal aborts. */
  catalog(signal: AbortSignal): Promise<AtlasCatalog>;
  /** Stops previews and requests, leaves sculpt mode, clears the sculpture, releases the start-up hold and holds change events. */
  beginRestore(): void;
  /** Takes the restored state as the new baseline for change events and lets them through again. */
  endRestore(): void;
  applySettings(settings: OrganRestoreSettings): void;
  /** The studio's generate() for a saved spec: resolves with the committed generation, rejects with the studio's message. */
  generate(spec: AtlasSpec, signal: AbortSignal): Promise<AtlasGeneration>;
  /** Commits a copy of the generation whose summary carries the stored provenance. */
  mergeProvenance(provenance: JsonRecord): void;
  applySculpt(edits: SurfaceEdit[]): void;
  /** Resolves once the viewport shows the committed generation and sculpture. */
  settle(signal: AbortSignal): Promise<void>;
  camera(): AtlasSessionCamera | null;
  setCamera(camera: AtlasSessionCamera): boolean;
  thumbnail(width: number, height: number): Promise<Blob | null>;
  /** The studio's default start-up: the reference of ?template (else the liver) with default settings. */
  startFresh(): void;
}

export const ADD_SHAPE_EXPORT_ID = "shape";

// --------------------------------------------------------------------------------------------- catalog lookups

const SHA256 = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function findTemplate(catalog: AtlasCatalog, templateId: string): { organ: AtlasOrgan; template: AtlasTemplate } | null {
  for (const organ of catalog.organs) {
    const template = organ.templates.find((entry) => entry.id === templateId);
    if (template) return { organ, template };
  }
  return null;
}

function shaOrNull(value: unknown): string | null {
  return typeof value === "string" && SHA256.test(value) ? value : null;
}

/** The catalog's disease library release (the profiles a disease spec is realized with). */
export function diseaseLibraryOf(catalog: AtlasCatalog): { version: string; profile_sha256: string | null } | null {
  const diseases = catalog.diseases as (AtlasCatalog["diseases"] & { profile_sha256?: unknown }) | undefined;
  return diseases ? { version: String(diseases.version).slice(0, 100), profile_sha256: shaOrNull(diseases.profile_sha256) } : null;
}

/** What the committed generation was realized against (see AtlasSessionBindings). */
export function bindingsOf(generation: AtlasGeneration, catalog: AtlasCatalog): AtlasSessionBindings {
  const spec = generation.spec;
  const metadata = generation.scene.metadata ?? {};
  const found = findTemplate(catalog, spec.template_id);
  const realizedBy = metadata.realized_by;
  const realizedId = typeof spec.realized_id === "string" ? spec.realized_id : typeof metadata.realized_id === "string" ? metadata.realized_id : null;
  let vertices = 0, triangles = 0;
  for (const organ of generation.scene.organs) {
    vertices += organ.positions.length / 3;
    triangles += organ.indices.length / 3;
  }
  return {
    template_sha256: shaOrNull(spec.template_sha256) ?? shaOrNull(found?.template.template_sha256),
    geometry_sha256: shaOrNull(metadata.geometry_sha256),
    realized_id: realizedId && realizedId.length <= 128 ? realizedId : null,
    realizer: isRecord(realizedBy) && typeof realizedBy.version === "string" && realizedBy.version ? realizedBy.version.slice(0, 100) : "api",
    catalog_renderer_version: catalog.renderer_version ?? null,
    disease_library: spec.disease ? diseaseLibraryOf(catalog) : null,
    material: spec.appearance === "tissue" && spec.material
      ? { version: String(spec.material.version), shader_version: ATLAS_MATERIAL_SHADER_VERSION, shader_sha256: ATLAS_MATERIAL_SHADER_SHA256 }
      : null,
    vessels_version: ATLAS_VESSEL_VERSION,
    vertex_count: vertices,
    triangle_count: triangles,
  };
}

/** The summary entries re-realizing a spec does not reproduce. */
export function provenanceOf(summary: Record<string, unknown>): JsonRecord {
  const out: JsonRecord = {};
  for (const key of PROVENANCE_KEYS) {
    const value = summary[key];
    if (isRecord(value)) out[key] = toJson(value, `state.provenance.${key}`);
  }
  return out;
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** "Liver · female reference", "Kidney · male reference · left". */
export function organTitle(catalog: AtlasCatalog, templateId: string): string {
  const found = findTemplate(catalog, templateId);
  if (!found) return templateId;
  return `${found.organ.label} · ${found.template.label.split(" · ").map(lowerFirst).join(" · ")}`;
}

function diseaseLabel(catalog: AtlasCatalog, spec: AtlasSpec): string | null {
  if (!spec.disease) return null;
  return catalog.diseases?.profiles.find((profile) => profile.id === spec.disease?.profile_id)?.label ?? spec.disease.profile_id;
}

function presetLabel(catalog: AtlasCatalog, spec: AtlasSpec): string | null {
  const material = spec.appearance === "tissue" ? spec.material : null;
  if (!material) return null;
  return catalog.materials?.presets.find((preset) => preset.id === material.preset)?.label ?? material.preset;
}

export function organSubtitle(state: OrganCurrentState): string {
  const { catalog, generation } = state;
  const spec = generation.spec;
  const parts: string[] = [];
  const disease = diseaseLabel(catalog, spec);
  if (disease) parts.push(`${disease} · synthetic design`);
  else {
    const preset = presetLabel(catalog, spec);
    parts.push(preset ? `${preset} surface` : spec.appearance === "clay" ? "Clay" : spec.appearance === "source" ? "Source colours" : "Tissue");
  }
  if (state.sculpt.length) parts.push("sculpted");
  return parts.join(" · ");
}

// --------------------------------------------------------------------------------------------- the document

export interface BuiltState {
  state: AtlasSessionState;
  sculptBytes: Uint8Array<ArrayBuffer> | null;
}

/** The saved state of what the studio shows, with the sculpture encoded against the realized surfaces. */
export async function buildSessionState(now: OrganCurrentState, camera: AtlasSessionCamera | null, labId: OrganLabId, textureLab: boolean): Promise<BuiltState> {
  const { generation, catalog } = now;
  let sculpt: AtlasSessionSculpt | null = null;
  let sculptBytes: Uint8Array<ArrayBuffer> | null = null;
  const edits = now.sculpt.filter((edit) => edit.positions.length > 0);
  if (edits.length) {
    const realized = (organId: string) => generation.scene.organs.find((organ) => organ.id === organId)?.positions;
    const encoded = encodeSculpt(edits, realized);
    const organs = await Promise.all(encoded.organs.map(async (organ) => ({ ...organ, base_sha256: await positionsSha256(realized(organ.organ_id)!) })));
    sculpt = { attachment: SCULPT_ATTACHMENT, codec: "vsc1", organs };
    sculptBytes = encoded.bytes;
  }
  const state: AtlasSessionState = {
    lab: labId,
    spec: toJsonRecord(generation.spec, "state.spec"),
    provenance: provenanceOf(generation.summary),
    bindings: bindingsOf(generation, catalog),
    vessels: { ...now.vessels },
    photo: textureLab ? { ...(now.photo ?? defaultPhoto(true)) } : null,
    view: { preset: now.view.preset, wireframe: now.view.wireframe, camera: camera ? roundCamera(camera) : null },
    sculpt,
    tools: { ...now.tools },
  };
  return { state, sculptBytes };
}

function versionsOf(state: AtlasSessionState): Record<string, string> {
  return {
    realizer: state.bindings.realizer,
    "material-shader": `${ATLAS_MATERIAL_SHADER_VERSION}@${ATLAS_MATERIAL_SHADER_SHA256.slice(0, 12)}`,
    vessels: ATLAS_VESSEL_VERSION,
    ...(state.bindings.catalog_renderer_version ? { renderer: state.bindings.catalog_renderer_version } : {}),
  };
}

/** The spec to hand generate(): the saved one without its realized_id (each realizer derives its own). */
export function specToRealize(saved: JsonRecord): AtlasSpec {
  const { realized_id: _realizedId, ...rest } = saved;
  return structuredClone(rest) as unknown as AtlasSpec;
}

function checkSculptFile(parsed: ParsedSculptOrgan[], manifest: AtlasSessionSculpt): void {
  const mismatch = () => new OrganSessionError("This saved organ cannot be opened: its sculpture file does not match its description.", "attachments.sculpt.vsc");
  if (parsed.length !== manifest.organs.length) throw mismatch();
  for (const entry of manifest.organs) {
    const organ = parsed.find((candidate) => candidate.organ_id === entry.organ_id);
    if (!organ || organ.vertex_count !== entry.vertex_count || organ.encoding !== entry.encoding || organ.changed !== entry.changed) throw mismatch();
  }
}

const REALIZER_NAMES: Record<string, string> = { api: "the VISCERA API" };
const realizerName = (id: string) => REALIZER_NAMES[id] ?? "the browser";

// --------------------------------------------------------------------------------------------- the adapter

export function createOrganLabAdapter(port: OrganStudioPort): LabSessionAdapter<AtlasSessionState> {
  let restoring = false;
  let exporting = false;
  // a restore was attempted on this load: startFresh() must then reset what it changed
  let restoreAttempted = false;

  const busy = (): false | string => {
    if (exporting) return "exporting";
    if (restoring) return "loading";
    // waiting for restore()/startFresh() is idle by contract (the platform waits for false before it restores)
    if (port.pending()) return false;
    return port.studioBusy();
  };

  const serialize = async (): Promise<LabSessionDocument<AtlasSessionState>> => {
    const now = port.current();
    if (!now) throw new OrganSessionError("The organ is still loading; there is nothing to save yet.");
    const { state, sculptBytes } = await buildSessionState(now, port.camera(), port.labId, port.textureLab);
    const document: LabSessionDocument<AtlasSessionState> = { schema: ATLAS_SESSION_SCHEMA, labId: port.labId, state, versions: versionsOf(state) };
    if (sculptBytes) document.attachments = { [SCULPT_ATTACHMENT]: new Blob([sculptBytes], { type: "application/octet-stream" }) };
    return document;
  };

  const restore = async (document: LabSessionDocument<AtlasSessionState>, signal: AbortSignal): Promise<LabRestoreReport> => {
    if (restoring) throw new OrganSessionError("A saved version is already being opened.");
    signal.throwIfAborted();
    const state = readAtlasSessionDocument(document, port.labId);
    let sculptFile: ParsedSculptOrgan[] | null = null;
    const warnings: string[] = [];
    let exact = true;
    if (state.sculpt) {
      const blob = document.attachments?.[state.sculpt.attachment];
      try {
        if (!blob) throw new OrganSessionError("The saved sculpture was not found; the organ is shown without it.");
        const parsed = parseSculpt(new Uint8Array(await blob.arrayBuffer()));
        checkSculptFile(parsed, state.sculpt);
        sculptFile = parsed;
      } catch (error) {
        // the organ itself is still worth showing; the platform keeps the saved version and flags the restore as inexact
        if (!(error instanceof OrganSessionError || error instanceof SculptCodecError)) throw error;
        warnings.push(error instanceof OrganSessionError && !blob ? error.message : "The saved sculpture could not be read; the organ is shown without it.");
        exact = false;
      }
    }
    restoring = true;
    restoreAttempted = true;
    port.beginRestore();
    try {
      const catalog = await port.catalog(signal);
      signal.throwIfAborted();
      const spec = specToRealize(state.spec);
      const found = findTemplate(catalog, spec.template_id);
      if (!found) throw new OrganSessionError(`This version uses the reference “${spec.template_id}”, which this copy of VISCERA does not include.`);
      if (spec.disease && !catalog.diseases?.profiles.some((profile) => profile.id === spec.disease?.profile_id && profile.supported !== false)) {
        throw new OrganSessionError(`This version uses the disease profile “${spec.disease.profile_id}”, which this copy of VISCERA does not offer.`);
      }
      const saved = state.bindings;
      const catalogTemplateSha = shaOrNull(found.template.template_sha256);
      if (saved.template_sha256 && catalogTemplateSha && saved.template_sha256 !== catalogTemplateSha) {
        warnings.push("The reference shape was updated since this version was saved; the organ was regenerated from the current reference.");
        exact = false;
      }
      if (spec.disease && saved.disease_library) {
        const current = diseaseLibraryOf(catalog);
        if (current && (current.version !== saved.disease_library.version || (saved.disease_library.profile_sha256 && current.profile_sha256 && current.profile_sha256 !== saved.disease_library.profile_sha256))) {
          warnings.push("The disease profiles were updated since this version was saved; the disease appearance may differ.");
          exact = false;
        }
      }
      const tissue = spec.appearance === "tissue" && Boolean(spec.material);
      if (tissue && saved.material && saved.material.shader_sha256 !== ATLAS_MATERIAL_SHADER_SHA256) {
        warnings.push("The tissue shader was updated since this version was saved; the surface may look slightly different.");
        exact = false;
      }
      if (tissue && state.vessels.enabled && saved.vessels_version !== ATLAS_VESSEL_VERSION) {
        warnings.push("The vessel pattern generator was updated since this version was saved; the branching may differ.");
        exact = false;
      }
      port.applySettings({
        vessels: state.vessels,
        photo: port.textureLab ? (state.photo ?? defaultPhoto(true)) : null,
        view: { preset: state.view.preset, wireframe: state.view.wireframe },
        tools: state.tools ?? null,
      });
      let generation: AtlasGeneration;
      try {
        generation = await port.generate(spec, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        throw new OrganSessionError(`The saved organ could not be regenerated: ${error instanceof Error ? error.message : String(error)}`);
      }
      signal.throwIfAborted();
      if (Object.keys(state.provenance).length) port.mergeProvenance(state.provenance);
      const realized = bindingsOf(generation, catalog);
      if (saved.geometry_sha256 && realized.geometry_sha256) {
        if (saved.geometry_sha256 !== realized.geometry_sha256) {
          warnings.push(saved.realizer !== realized.realizer
            ? `This version was made by ${realizerName(saved.realizer)}; here it was regenerated by ${realizerName(realized.realizer)}, which agrees to about a micrometre but not bit for bit.`
            : "The regenerated organ differs slightly from the saved one.");
          exact = false;
        }
      } else {
        warnings.push("The regenerated organ could not be compared with the saved one.");
        exact = false;
      }
      if (sculptFile && state.sculpt) {
        const edits: SurfaceEdit[] = [];
        for (const organ of sculptFile) {
          const surface = generation.scene.organs.find((candidate) => candidate.id === organ.organ_id);
          if (!surface || surface.positions.length !== organ.vertex_count * 3) {
            warnings.push("The saved sculpture no longer fits this organ and was left out.");
            exact = false;
            continue;
          }
          const manifest = state.sculpt.organs.find((entry) => entry.organ_id === organ.organ_id)!;
          if ((await positionsSha256(surface.positions)) !== manifest.base_sha256) {
            warnings.push("The sculpted areas were put back on a slightly different surface than the one they were made on.");
            exact = false;
          }
          edits.push({ organ_id: organ.organ_id, positions: sculptPositions(organ, surface.positions) });
        }
        signal.throwIfAborted();
        if (edits.length) port.applySculpt(edits);
      }
      await port.settle(signal);
      if (state.view.camera && !port.setCamera(state.view.camera)) {
        warnings.push("The saved camera could not be applied; the organ is framed automatically.");
        exact = false;
      }
      return { exact, warnings };
    } finally {
      restoring = false;
      port.endRestore();
    }
  };

  const startFresh = (): void => {
    if (restoring) return;
    // a lab that started normally has nothing to do; one waiting (or whose restore failed) starts now
    if (!port.pending() && !restoreAttempted) return;
    restoreAttempted = false;
    port.startFresh();
  };

  const addShape = async (signal: AbortSignal): Promise<LabLibraryExport> => {
    if (exporting) throw new OrganSessionError("The organ is already being added to the Library.");
    exporting = true;
    try {
      const now = port.current();
      if (!now || !now.displayedScene) throw new OrganSessionError("There is no organ to add yet.");
      const { state, sculptBytes } = await buildSessionState(now, port.camera(), port.labId, port.textureLab);
      const thumbnail = await port.thumbnail(512, 512).catch(() => null);
      signal.throwIfAborted();
      const found = findTemplate(now.catalog, now.generation.spec.template_id);
      const { buildShapeExport } = await import("./shapeExport");
      return await buildShapeExport({
        labId: port.labId,
        title: organTitle(now.catalog, now.generation.spec.template_id),
        subtitle: organSubtitle(now),
        scene: now.displayedScene,
        appearance: now.generation.spec.appearance,
        state,
        sculptBytes,
        organ: found ? { id: found.organ.id, label: found.organ.label } : null,
        template: found?.template ?? null,
        diseaseLabel: diseaseLabel(now.catalog, now.generation.spec),
        photoTile: port.textureLab && (now.photo?.strength ?? 0) > 0 ? now.photoTile : null,
        thumbnail,
        signal,
      });
    } finally {
      exporting = false;
    }
  };

  return {
    labId: port.labId,
    title: ORGAN_LAB_TITLES[port.labId],
    serialize,
    restore,
    startFresh,
    busy,
    async thumbnail(width, height) {
      if (busy() || !port.current()) return null;
      return port.thumbnail(width, height);
    },
    exports(): LabExportAction[] {
      return [{ id: ADD_SHAPE_EXPORT_ID, label: "Add shape to Library", kind: "shape", run: addShape }];
    },
    describe() {
      const now = port.current();
      if (!now) return {};
      return { title: organTitle(now.catalog, now.generation.spec.template_id), subtitle: organSubtitle(now) };
    },
  };
}
