// "Add shape to Library" for Organ Design and the Texture Lab (DESIGN.md §9). The item is the displayed organ as a GLB
// (positions as displayed, sculpture included, in metres, Y up; vertex colours baked in the browser by vertexBake.ts),
// the spec that regenerates it (spec.json), the sculpture file when there is one, and a thumbnail. The honesty strings
// say what the item is and is not; the reference template's source and licence travel as its rights. Loaded on demand
// by the adapter, so the bake and the material field stay out of the studio's first paint.

import type { SceneData } from "@viscera/render";
import type { LabLibraryExport, LabLibraryFile } from "../../bridge/labSession";
import type { AtlasAppearance, AtlasTemplate } from "../../../atlas";
import type { PhotoTileInfo } from "../../../photoDetail";
import { writeGlb } from "./glb";
import { ORGAN_LAB_TITLES, SCULPT_ATTACHMENT, type AtlasSessionState, type JsonRecord, type OrganLabId } from "./session";
import { VERTEX_BAKE_VERSION, bakeDisplayedScene, type BakedMesh } from "./vertexBake";

export const SHAPE_SCHEMA = "viscera.organ-shape/1";
export const SHAPE_EVIDENCE = "Synthetic anatomical variation generated in VISCERA; procedural, authored appearance baked to vertex colours";
export const SHAPE_LIMITATIONS: readonly string[] = [
  "Not measured patient anatomy",
  "Not clinically validated",
  "Vertex-colour bake is coarser than the on-screen material; full-resolution textures need the VISCERA API",
];
// what the studio itself says next to these controls (AtlasStudio.tsx), word for word
export const DISEASE_NOTE = "Synthetic design controls, not clinical diagnosis, staging or a patient-specific surgical plan.";
export const SCULPT_NOTE = "Geometry-inspired authoring with local stretch and fold guards. This tool does not simulate measured tissue mechanics or prevent every self-intersection.";
export const PHOTO_NOTE = "The texture lab's photo detail is a viewer layer: the thumbnail shows it, the GLB does not carry it.";
const MAX_METADATA_BYTES = 60_000;

export interface ShapeExportInput {
  labId: OrganLabId;
  title: string;
  subtitle: string;
  /** The scene as displayed (vessels and sculpture applied). */
  scene: SceneData;
  appearance: AtlasAppearance;
  /** The session state of the same moment (spec, provenance, bindings, settings, sculpt manifest). */
  state: AtlasSessionState;
  sculptBytes: Uint8Array<ArrayBuffer> | null;
  organ: { id: string; label: string } | null;
  template: AtlasTemplate | null;
  diseaseLabel: string | null;
  /** The texture lab's photograph when its layer is visible (the thumbnail shows it). */
  photoTile: PhotoTileInfo | null;
  thumbnail: Blob | null;
  signal: AbortSignal;
}

export interface ShapeClaims {
  evidence: string;
  limitations: string[];
  rights?: string;
}

function photoCredit(tile: PhotoTileInfo): string {
  const source = tile.source;
  return `${source.collection}, ${source.license ?? "licensed"}; ${source.credit ?? source.id}`;
}

/** Evidence, limitations and rights of the item (the platform shows them verbatim). */
export function shapeClaims(input: Pick<ShapeExportInput, "template" | "diseaseLabel" | "photoTile" | "state">): ShapeClaims {
  const limitations = [...SHAPE_LIMITATIONS];
  if (input.diseaseLabel) limitations.push(DISEASE_NOTE);
  if (input.state.sculpt) limitations.push(SCULPT_NOTE);
  if (input.photoTile) limitations.push(PHOTO_NOTE);
  const rights: string[] = [];
  const template = input.template;
  if (template) {
    const url = typeof template.source_url === "string" && /^https?:\/\//.test(template.source_url) ? ` (${template.source_url})` : "";
    rights.push(`Reference geometry: ${template.source}, ${template.license}${url}; credit the source when you share it.`);
  }
  if (input.photoTile) rights.push(`Thumbnail photo detail: ${photoCredit(input.photoTile)}.`);
  return rights.length ? { evidence: SHAPE_EVIDENCE, limitations, rights: rights.join(" ") } : { evidence: SHAPE_EVIDENCE, limitations };
}

/** Library tags: at most 20, 1–32 characters, distinct ignoring case (the database's rule). */
export function shapeTags(values: readonly (string | null | undefined)[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    if (!raw) continue;
    let tag = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
    if (tag.length > 32) tag = `${tag.slice(0, 31).trimEnd()}…`;
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
    if (out.length === 20) break;
  }
  return out;
}

function safeFileStem(text: string): string {
  const stem = text.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "").slice(0, 120);
  return stem || "organ";
}

function measurements(meshes: readonly BakedMesh[]): { extent_mm: [number, number, number]; vertices: number; triangles: number } {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let vertices = 0, triangles = 0;
  for (const mesh of meshes) {
    vertices += mesh.positionsM.length / 3;
    triangles += mesh.indices.length / 3;
    for (let i = 0; i < mesh.positionsM.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const value = mesh.positionsM[i + k]! * 1000;
        if (value < min[k]!) min[k] = value;
        if (value > max[k]!) max[k] = value;
      }
    }
  }
  const extent = [0, 1, 2].map((k) => Number((max[k]! - min[k]!).toFixed(3))) as [number, number, number];
  return { extent_mm: extent, vertices, triangles };
}

export async function buildShapeExport(input: ShapeExportInput): Promise<LabLibraryExport> {
  const meshes = await bakeDisplayedScene(input.scene, { appearance: input.appearance, signal: input.signal });
  input.signal.throwIfAborted();
  const claims = shapeClaims(input);
  const claimsJson: JsonRecord = { evidence: claims.evidence, limitations: claims.limitations, ...(claims.rights ? { rights: claims.rights } : {}) };
  const templateId = typeof input.state.spec.template_id === "string" ? input.state.spec.template_id : "organ";
  const meshFile = `${safeFileStem(templateId)}.glb`;
  const sculpted = Boolean(input.state.sculpt && input.sculptBytes);
  const measured = measurements(meshes);
  const baked = {
    colours: [...new Set(meshes.map((mesh) => mesh.colourSource))],
    disease: meshes.some((mesh) => mesh.diseaseBaked),
    vessels: meshes.some((mesh) => mesh.vesselsBaked),
    photo_detail: false,
  };
  const glb = writeGlb({
    generator: `VISCERA ${ORGAN_LAB_TITLES[input.labId]} (${VERTEX_BAKE_VERSION})`,
    sceneName: input.title,
    meshes: meshes.map((mesh) => ({
      name: mesh.name,
      positions: mesh.positionsM,
      normals: mesh.normals,
      colors: mesh.colors,
      indices: mesh.indices,
      material: mesh.material,
      extras: { organ_id: mesh.organId, kind: mesh.kind },
    })),
    extras: {
      viscera: {
        schema: SHAPE_SCHEMA,
        lab: input.labId,
        title: input.title,
        spec: input.state.spec,
        bindings: input.state.bindings,
        texturing: VERTEX_BAKE_VERSION,
        unit: "m",
        up: "Y",
        sculpted,
        claims: claimsJson,
      },
    },
  });
  const specDocument: JsonRecord = {
    schema: SHAPE_SCHEMA,
    lab: input.labId,
    title: input.title,
    spec: input.state.spec,
    provenance: input.state.provenance,
    bindings: input.state.bindings,
    vessels: input.state.vessels,
    photo: input.state.photo,
    sculpt: input.state.sculpt,
    camera: input.state.view.camera,
    files: { mesh: meshFile, ...(sculpted ? { sculpt: SCULPT_ATTACHMENT } : {}) },
    texturing: VERTEX_BAKE_VERSION,
    baked,
    unit: "m",
    up: "Y",
    measurements: measured,
    claims: claimsJson,
  };
  const files: LabLibraryFile[] = [
    { filename: meshFile, role: "mesh", blob: new Blob([glb], { type: "model/gltf-binary" }) },
    { filename: "spec.json", role: "spec", blob: new Blob([`${JSON.stringify(specDocument, null, 2)}\n`], { type: "application/json" }) },
  ];
  if (sculpted && input.sculptBytes) files.push({ filename: SCULPT_ATTACHMENT, role: "data", blob: new Blob([input.sculptBytes], { type: "application/octet-stream" }) });
  if (input.thumbnail) files.push({ filename: input.thumbnail.type === "image/png" ? "thumbnail.png" : "thumbnail.webp", role: "thumbnail", blob: input.thumbnail });
  let metadata: JsonRecord = {
    schema: SHAPE_SCHEMA,
    lab: input.labId,
    organ: input.organ ? { id: input.organ.id, label: input.organ.label } : null,
    template: input.template
      ? { id: input.template.id, label: input.template.label, source: input.template.source, license: input.template.license, ...(typeof input.template.source_url === "string" ? { source_url: input.template.source_url } : {}) }
      : null,
    spec: input.state.spec,
    provenance: input.state.provenance,
    bindings: input.state.bindings,
    sculpted,
    texturing: VERTEX_BAKE_VERSION,
    baked,
    unit: "m",
    up: "Y",
    measurements: measured,
  };
  // the database keeps item metadata under 64 KB; sampler provenance can be long and is in spec.json anyway
  if (new TextEncoder().encode(JSON.stringify(metadata)).length > MAX_METADATA_BYTES) {
    const { provenance: _provenance, ...rest } = metadata;
    metadata = rest;
  }
  return {
    kind: "shape",
    title: input.title,
    description: input.subtitle,
    tags: shapeTags([input.organ?.label, input.template?.label, input.diseaseLabel, sculpted ? "Sculpted" : null, ORGAN_LAB_TITLES[input.labId]]),
    files,
    thumbnail: input.thumbnail,
    metadata,
    claims,
  };
}
