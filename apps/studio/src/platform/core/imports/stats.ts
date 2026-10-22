// Measurements of a loaded scene (DOM-free, runs in node): renderable objects, drawn vertices and triangles, distinct
// materials and images, skinning, morph targets and the axis-aligned size, plus the geometry limits.

import * as THREE from "three";
import type { ImportStats } from "../types";
import { ADVICE, importRefusal } from "./errors";
import { IMPORT_LIMITS, formatCount } from "./limits";

export interface SceneMeasure {
  /** Renderable objects: meshes, point clouds and line sets. */
  meshes: number;
  /**
   * Stored vertices of indexed geometry, distinct positions of non-indexed meshes (OBJ, FBX, STL), points of point
   * clouds; an instanced mesh counts once per instance.
   */
  vertices: number;
  triangles: number;
  pointClouds: number;
  lineSets: number;
  materials: number;
  /** Distinct images used by materials (textures sharing an image count once). */
  textures: number;
  skinned: boolean;
  morphTargets: boolean;
  largestImage: { width: number; height: number } | null;
  bbox: { x: number; y: number; z: number } | null;
}

function imageDimensions(image: unknown): { width: number; height: number } | null {
  if (typeof image !== "object" || image === null) return null;
  const record = image as { width?: unknown; height?: unknown; naturalWidth?: unknown; naturalHeight?: unknown };
  const width = typeof record.naturalWidth === "number" && record.naturalWidth > 0 ? record.naturalWidth : record.width;
  const height = typeof record.naturalHeight === "number" && record.naturalHeight > 0 ? record.naturalHeight : record.height;
  return typeof width === "number" && typeof height === "number" && width > 0 && height > 0 ? { width, height } : null;
}

/** Textures referenced by a material's own properties (map, normalMap, …). */
export function materialTextures(material: THREE.Material): THREE.Texture[] {
  return Object.values(material).filter((value): value is THREE.Texture => value instanceof THREE.Texture);
}

export function forEachMaterial(root: THREE.Object3D, visit: (material: THREE.Material, owner: THREE.Object3D) => void): void {
  root.traverse((node) => {
    const material = (node as Partial<THREE.Mesh>).material;
    if (Array.isArray(material)) material.forEach((entry) => visit(entry, node));
    else if (material instanceof THREE.Material) visit(material, node);
  });
}

function significant(value: number): number {
  return Number(value.toPrecision(6));
}

/** Bit pattern of -0 as a float32. */
const NEGATIVE_ZERO = 0x80000000;

/**
 * Distinct positions of a non-indexed geometry. OBJ, FBX and STL loaders repeat a vertex for every triangle corner;
 * counting distinct positions gives the vertex count modelling tools show instead of three times the triangles.
 * Open addressing over the float32 bit patterns: linear time, one Int32Array of at most 2.5× the corner count.
 */
export function distinctPositions(position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): number {
  const count = position.count;
  if (count === 0) return 0;
  const array = (position as THREE.BufferAttribute).array;
  let bits: Uint32Array;
  if (!(position as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute && array instanceof Float32Array && position.itemSize === 3) {
    bits = new Uint32Array(array.buffer, array.byteOffset, count * 3);
  } else {
    const packed = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      packed[i * 3] = position.getX(i);
      packed[i * 3 + 1] = position.getY(i);
      packed[i * 3 + 2] = position.getZ(i);
    }
    bits = new Uint32Array(packed.buffer);
  }
  let size = 1;
  while (size < count + (count >> 2)) size *= 2;
  const mask = size - 1;
  const table = new Int32Array(size).fill(-1);
  let distinct = 0;
  // -0 and +0 are the same position (generated spheres and mirrored models are full of both).
  const key = (value: number) => (value === NEGATIVE_ZERO ? 0 : value);
  for (let i = 0; i < count; i++) {
    const a = key(bits[i * 3]!);
    const b = key(bits[i * 3 + 1]!);
    const c = key(bits[i * 3 + 2]!);
    let slot = (Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca77) ^ Math.imul(c, 0xc2b2ae3d)) & mask;
    for (;;) {
      const j = table[slot]!;
      if (j === -1) {
        table[slot] = i;
        distinct++;
        break;
      }
      if (key(bits[j * 3]!) === a && key(bits[j * 3 + 1]!) === b && key(bits[j * 3 + 2]!) === c) break;
      slot = (slot + 1) & mask;
    }
  }
  return distinct;
}

export function measureScene(root: THREE.Object3D): SceneMeasure {
  root.updateMatrixWorld(true);
  let meshes = 0;
  let vertices = 0;
  let triangles = 0;
  let pointClouds = 0;
  let lineSets = 0;
  let skinned = false;
  let morphTargets = false;
  const materials = new Set<THREE.Material>();
  const images = new Set<unknown>();
  const distinct = new Map<THREE.BufferGeometry, number>();
  let largestImage: { width: number; height: number } | null = null;

  root.traverse((node) => {
    const object = node as Partial<THREE.Mesh>;
    const geometry = object.geometry;
    if (!(geometry instanceof THREE.BufferGeometry)) return;
    const isMesh = node instanceof THREE.Mesh;
    const isPoints = node instanceof THREE.Points;
    const isLine = node instanceof THREE.Line;
    if (!isMesh && !isPoints && !isLine) return;
    const position = geometry.getAttribute("position");
    if (!position) return;
    const instances = node instanceof THREE.InstancedMesh ? node.count : 1;
    meshes++;
    let unique = distinct.get(geometry);
    if (unique === undefined) {
      unique = isMesh && !geometry.index ? distinctPositions(position) : position.count;
      distinct.set(geometry, unique);
    }
    vertices += unique * instances;
    if (isMesh) {
      const elements = geometry.index ? geometry.index.count : position.count;
      triangles += Math.floor(elements / 3) * instances;
    }
    if (isPoints) pointClouds++;
    if (isLine) lineSets++;
    if (node instanceof THREE.SkinnedMesh) skinned = true;
    if (Object.values(geometry.morphAttributes).some((list) => (list?.length ?? 0) > 0)) morphTargets = true;
  });

  forEachMaterial(root, (material) => {
    materials.add(material);
    for (const texture of materialTextures(material)) {
      const image: unknown = texture.image;
      if (image === undefined || image === null) continue;
      images.add(texture.source ?? image);
      const size = imageDimensions(image);
      if (size && (!largestImage || Math.max(size.width, size.height) > Math.max(largestImage.width, largestImage.height))) largestImage = size;
    }
  });

  const box = new THREE.Box3().setFromObject(root, true);
  let bbox: SceneMeasure["bbox"] = null;
  if (!box.isEmpty()) {
    const size = box.getSize(new THREE.Vector3());
    if ([size.x, size.y, size.z].every(Number.isFinite)) {
      // Rotations leave round-off (1e-16) on flat sides; anything a billionth of the largest side is zero.
      const largest = Math.max(size.x, size.y, size.z);
      const clean = (value: number) => (value <= largest * 1e-9 ? 0 : significant(value));
      bbox = { x: clean(size.x), y: clean(size.y), z: clean(size.z) };
    }
  }

  return { meshes, vertices, triangles, pointClouds, lineSets, materials: materials.size, textures: images.size, skinned, morphTargets, largestImage, bbox };
}

/** Refuses scenes above the import limits (vertices, triangles, images, image size). */
export function checkSceneLimits(measure: SceneMeasure, label: string): void {
  if (measure.meshes === 0) {
    throw importRefusal(`${label} contains no meshes, points or lines to show.`, "empty-scene", {
      advice: ADVICE.emptyScene,
    });
  }
  if (measure.vertices > IMPORT_LIMITS.vertices) {
    throw importRefusal(`${label} has ${formatCount(measure.vertices)} vertices; imports are limited to ${formatCount(IMPORT_LIMITS.vertices)}.`, "limit:vertices", {
      code: "limit_reached",
      advice: ADVICE.decimate,
    });
  }
  if (measure.triangles > IMPORT_LIMITS.triangles) {
    throw importRefusal(`${label} has ${formatCount(measure.triangles)} triangles; imports are limited to ${formatCount(IMPORT_LIMITS.triangles)}.`, "limit:triangles", {
      code: "limit_reached",
      advice: ADVICE.decimate,
    });
  }
  if (measure.textures > IMPORT_LIMITS.textures) {
    throw importRefusal(`${label} uses ${measure.textures} texture images; imports are limited to ${IMPORT_LIMITS.textures}.`, "limit:textures", {
      code: "limit_reached",
      advice: "Combine textures into an atlas or leave unused ones out, then export again.",
    });
  }
  const largest = measure.largestImage;
  if (largest && Math.max(largest.width, largest.height) > IMPORT_LIMITS.imageSide) {
    throw importRefusal(
      `${label} has a ${largest.width}×${largest.height} texture; textures are limited to ${IMPORT_LIMITS.imageSide} pixels per side.`,
      "limit:image-size",
      { code: "limit_reached", advice: ADVICE.resizeTextures },
    );
  }
}

export interface StatsContext {
  animations: number;
  units?: string | undefined;
  upAxis?: "Y" | "Z" | undefined;
  notes?: string[];
}

/** The stored statistics (JSON-safe: optional fields are left out rather than undefined). */
export function toImportStats(measure: SceneMeasure, context: StatsContext): ImportStats {
  const stats: ImportStats = {
    meshes: measure.meshes,
    vertices: measure.vertices,
    triangles: measure.triangles,
    materials: measure.materials,
    textures: measure.textures,
    animations: context.animations,
    skinned: measure.skinned,
    bbox: measure.bbox,
  };
  if (context.units) stats.units = context.units;
  if (context.upAxis) stats.upAxis = context.upAxis;
  if (context.notes && context.notes.length > 0) stats.notes = context.notes;
  return stats;
}
