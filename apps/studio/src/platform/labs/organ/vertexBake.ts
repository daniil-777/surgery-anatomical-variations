// The displayed organ baked to vertex colours, for "Add shape to Library" (DESIGN.md §9). On screen the tissue colour is
// a procedural field evaluated per fragment (atlasMaterialShader.ts), a disease tint mixed in linear light and surface
// vessels drawn over it (atlasVesselShader.ts). The same three steps run here on the CPU, in the GPU's order, through
// the studio's own reference functions: sampleMaterialField (atlasMaterialSampler.ts), the disease site mask, and
// sampleAtlasVessels / applyAtlasVesselColor (atlasVessels.ts) culled by the shader's own grid. Each vertex is sampled
// with a footprint of its mean edge length, so detail finer than the mesh is band-limited instead of aliased; the result
// is coarser than the screen and is labelled so. The texture lab's photo layer is a viewer layer and is not baked.
// Clay and source appearances keep the specimen's own vertex colours, as the viewport shows them.

import * as THREE from "three";
import type { OrganMesh, SceneData } from "@viscera/render";
import type { AtlasAppearance } from "../../../atlas";
import { vertexNormals } from "../../../atlasLocal";
import { sampleMaterialField } from "../../../atlasMaterialSampler";
import { readAtlasMaterial, type AtlasDiseaseField } from "../../../atlasMaterialShader";
import { createAtlasVesselGrid } from "../../../atlasVesselShader";
import { applyAtlasVesselColor, sampleAtlasVessels, type AtlasVesselNetwork, type VesselVec3 } from "../../../atlasVessels";
import type { GlbMaterialInput } from "./glb";

export const VERTEX_BAKE_VERSION = "vertex-colour-bake/1";

export type BakeColourSource = "material-field" | "vertex-colours" | "flat";

export interface BakedMesh {
  name: string;
  organId: string;
  kind: string;
  /** xyz per vertex in metres (the scene is millimetres). */
  positionsM: Float32Array;
  normals: Float32Array;
  /** Linear RGB per vertex, or null when the material colour is flat. */
  colors: Float32Array | null;
  indices: Uint32Array;
  material: GlbMaterialInput;
  colourSource: BakeColourSource;
  vesselsBaked: boolean;
  diseaseBaked: boolean;
}

export interface BakeOptions {
  appearance: AtlasAppearance;
  signal?: AbortSignal | undefined;
}

const MM_TO_M = 0.001;
const linear = new THREE.Color();

function srgbToLinearTriple(r: number, g: number, b: number): [number, number, number] {
  linear.setRGB(r, g, b, THREE.SRGBColorSpace);
  return [linear.r, linear.g, linear.b];
}

function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("The export was cancelled.", "AbortError");
}

/** Gives the page a frame between heavy steps (a brain has 212 000 vertices). */
function breathe(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0)).then(() => checkAbort(signal));
}

/** AtlasViewport's materialValue: a 0–1 finish value from the specimen's appearance block, else the fallback. */
function finishValue(definition: unknown, key: string, fallback: number): number {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) return fallback;
  const value = (definition as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

/** The normals the viewport shades with: the specimen's own, or three's area-weighted ones after a sculpture. */
function displayNormals(organ: OrganMesh): Float32Array {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(organ.positions, 3));
  geometry.setIndex(organ.indices);
  if (organ.normals && organ.normals.length === organ.positions.length) geometry.setAttribute("normal", new THREE.Float32BufferAttribute(organ.normals, 3));
  else geometry.computeVertexNormals();
  const source = geometry.getAttribute("normal").array as Float32Array;
  const normals = new Float32Array(source.length);
  for (let i = 0; i < source.length; i += 3) {
    const x = source[i]!, y = source[i + 1]!, z = source[i + 2]!;
    const length = Math.hypot(x, y, z);
    // glTF requires unit normals; an isolated vertex has none, so it gets "up"
    if (!(length > 1e-12)) {
      normals[i + 1] = 1;
      continue;
    }
    normals[i] = x / length;
    normals[i + 1] = y / length;
    normals[i + 2] = z / length;
  }
  geometry.dispose();
  return normals;
}

/** Mean length of the edges at each vertex, in the given frame: the sampling footprint of one vertex. */
export function vertexFootprints(points: ArrayLike<number>, indices: ArrayLike<number>): Float64Array {
  const n = points.length / 3;
  const sum = new Float64Array(n), count = new Uint32Array(n);
  const edge = (a: number, b: number) => {
    const length = Math.hypot(points[b * 3]! - points[a * 3]!, points[b * 3 + 1]! - points[a * 3 + 1]!, points[b * 3 + 2]! - points[a * 3 + 2]!);
    sum[a] = sum[a]! + length; count[a] = count[a]! + 1;
    sum[b] = sum[b]! + length; count[b] = count[b]! + 1;
  };
  for (let f = 0; f < indices.length; f += 3) {
    const a = indices[f]!, b = indices[f + 1]!, c = indices[f + 2]!;
    edge(a, b); edge(b, c); edge(c, a);
  }
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = count[i] ? sum[i]! / count[i]! : 0;
  return out;
}

/** The GPU's disease tint: max over sites of max(1 - |(p - c) / r|², 0)³, times the colour strength, mixed in linear light. */
export function applyDiseaseTint(colors: Float64Array, rest: ArrayLike<number>, field: AtlasDiseaseField): void {
  const target = srgbToLinearTriple(field.target_srgb[0], field.target_srgb[1], field.target_srgb[2]);
  const n = colors.length / 3;
  for (let i = 0; i < n; i++) {
    let mask = 0;
    for (const site of field.fields) {
      const dx = (rest[i * 3]! - site.center_mm[0]) / site.radius_mm;
      const dy = (rest[i * 3 + 1]! - site.center_mm[1]) / site.radius_mm;
      const dz = (rest[i * 3 + 2]! - site.center_mm[2]) / site.radius_mm;
      const support = Math.max(1 - (dx * dx + dy * dy + dz * dz), 0);
      mask = Math.max(mask, support * support * support);
    }
    const amount = mask * field.color_strength;
    if (amount === 0) continue;
    for (let k = 0; k < 3; k++) colors[i * 3 + k] = colors[i * 3 + k]! * (1 - amount) + target[k]! * amount;
  }
}

/** Vessels over the colours (and the roughness the vessel shader lowers), sampled at the rest points. */
async function applyVessels(colors: Float64Array, roughness: Float64Array | null, rest: ArrayLike<number>, indices: ArrayLike<number>, footprint: Float64Array, network: AtlasVesselNetwork, signal: AbortSignal | undefined): Promise<boolean> {
  if (!network.segments.length || !(network.settings.visibility > 0)) return false;
  const grid = createAtlasVesselGrid(network);
  const restNormals = vertexNormals(Float64Array.from(rest), indices);
  const dimX = grid.dimensions.x, dimY = grid.dimensions.y, dimZ = grid.dimensions.z;
  const cells = new Map<number, AtlasVesselNetwork | null>();
  const cellNetwork = (flat: number): AtlasVesselNetwork | null => {
    let entry = cells.get(flat);
    if (entry === undefined) {
      const start = grid.headers[flat * 4]!, length = grid.headers[flat * 4 + 1]!;
      const segments = [];
      for (let k = 0; k < length; k++) {
        const segment = network.segments[grid.candidates[start + k]!];
        if (segment) segments.push(segment);
      }
      entry = segments.length ? { ...network, segments } : null;
      cells.set(flat, entry);
    }
    return entry;
  };
  const n = colors.length / 3;
  for (let i = 0; i < n; i++) {
    if (i > 0 && i % 40000 === 0) await breathe(signal);
    const point: VesselVec3 = [rest[i * 3]!, rest[i * 3 + 1]!, rest[i * 3 + 2]!];
    const x = Math.floor((point[0] - grid.origin.x) / grid.cellSize);
    const y = Math.floor((point[1] - grid.origin.y) / grid.cellSize);
    const z = Math.floor((point[2] - grid.origin.z) / grid.cellSize);
    // outside the grid no segment reaches the point (the grid spans every segment's support)
    if (x < 0 || y < 0 || z < 0 || x >= dimX || y >= dimY || z >= dimZ) continue;
    const local = cellNetwork(x + dimX * (y + dimY * z));
    if (!local) continue;
    const normal: VesselVec3 = [restNormals[i * 3]!, restNormals[i * 3 + 1]!, restNormals[i * 3 + 2]!];
    const sample = sampleAtlasVessels(point, normal, local, footprint[i]!);
    if (sample.artery === 0 && sample.vein === 0 && sample.core === 0) continue;
    const mixed = applyAtlasVesselColor([colors[i * 3]!, colors[i * 3 + 1]!, colors[i * 3 + 2]!], sample);
    colors[i * 3] = mixed[0]; colors[i * 3 + 1] = mixed[1]; colors[i * 3 + 2] = mixed[2];
    if (roughness) roughness[i] = Math.min(0.9, Math.max(0.16, roughness[i]! - 0.035 * sample.core));
  }
  return true;
}

function toColorArray(values: Float64Array): Float32Array {
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = Math.min(1, Math.max(0, values[i]!));
  return out;
}

function mean(values: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i]!;
  return values.length ? sum / values.length : 0;
}

/** Bakes every organ and vessel mesh of the displayed scene (positions as displayed: sculpted, in metres). */
export async function bakeDisplayedScene(scene: SceneData, options: BakeOptions): Promise<BakedMesh[]> {
  const { appearance, signal } = options;
  const out: BakedMesh[] = [];
  for (const organ of [...scene.organs, ...(scene.vessels ?? [])]) {
    checkAbort(signal);
    const n = organ.positions.length / 3;
    if (!Number.isInteger(n) || n === 0 || organ.indices.length % 3 !== 0 || organ.indices.length === 0) continue;
    const positionsM = new Float32Array(organ.positions.length);
    for (let i = 0; i < organ.positions.length; i++) positionsM[i] = organ.positions[i]! * MM_TO_M;
    const normals = displayNormals(organ);
    const indices = Uint32Array.from(organ.indices);
    const fields = organ as OrganMesh & { rest_positions?: number[]; sculpt_reference_positions?: number[] };
    const definition = appearance === "tissue" ? readAtlasMaterial(organ, scene) : null;
    const vessels = appearance === "tissue" ? organ.metadata?.surface_vessels as AtlasVesselNetwork | undefined : undefined;
    let colors: Float64Array | null = null;
    let roughness: Float64Array | null = null;
    let colourSource: BakeColourSource = "flat";
    let material: GlbMaterialInput;
    let diseaseBaked = false;
    let vesselsBaked = false;
    if (definition) {
      const rest = definition.restPositions;
      const footprint = vertexFootprints(rest, organ.indices);
      const field = sampleMaterialField(definition.recipe, rest, definition.regions, footprint);
      colors = field.rgbLinear;
      roughness = Float64Array.from(field.roughness);
      colourSource = "material-field";
      if (definition.diseaseField) {
        applyDiseaseTint(colors, rest, definition.diseaseField);
        diseaseBaked = true;
      }
      await breathe(signal);
      if (vessels) vesselsBaked = await applyVessels(colors, roughness, rest, organ.indices, footprint, vessels, signal);
      material = {
        name: `${organ.name} · ${definition.recipe.preset} tissue (vertex colours)`,
        baseColorFactor: [1, 1, 1, 1],
        metallicFactor: definition.resolved.metalness,
        roughnessFactor: mean(roughness),
        doubleSided: true,
        clearcoat: { factor: definition.resolved.clearcoat, roughness: definition.resolved.clearcoat_roughness },
      };
    } else {
      const look = organ.metadata?.appearance ?? scene.metadata?.appearance;
      const clay = appearance === "clay";
      if (organ.colors && organ.colors.length === organ.positions.length) {
        colors = new Float64Array(organ.colors.length);
        for (let i = 0; i < organ.colors.length; i += 3) {
          const [r, g, b] = srgbToLinearTriple(organ.colors[i]!, organ.colors[i + 1]!, organ.colors[i + 2]!);
          colors[i] = r; colors[i + 1] = g; colors[i + 2] = b;
        }
        colourSource = "vertex-colours";
      }
      let base: [number, number, number, number] = [1, 1, 1, 1];
      if (!colors) {
        linear.set(organ.color);
        base = [linear.r, linear.g, linear.b, 1];
      }
      if (vessels && colors) {
        const rest = fields.rest_positions ?? fields.sculpt_reference_positions ?? organ.positions;
        vesselsBaked = await applyVessels(colors, null, rest, organ.indices, vertexFootprints(rest, organ.indices), vessels, signal);
      }
      material = {
        name: `${organ.name} · ${appearance}`,
        baseColorFactor: base,
        metallicFactor: finishValue(look, "metalness", 0),
        roughnessFactor: finishValue(look, "roughness", clay ? 0.83 : appearance === "source" ? 0.65 : 0.48),
        doubleSided: true,
        clearcoat: { factor: finishValue(look, "clearcoat", appearance === "tissue" ? 0.12 : 0), roughness: finishValue(look, "clearcoat_roughness", 0.3) },
      };
    }
    out.push({
      name: organ.name, organId: organ.id, kind: organ.kind, positionsM, normals, colors: colors ? toColorArray(colors) : null, indices, material,
      colourSource, vesselsBaked, diseaseBaked,
    });
    await breathe(signal);
  }
  if (!out.length) throw new Error("The displayed organ has no surface to export.");
  return out;
}
