// The preview copy of an import: the loaded scene made upright (Y-up) and metric where the units are known, without
// the file's lights and cameras, with Phong/Lambert materials turned into PBR ones (so image-based lighting and the
// GLB export render them sensibly), and exported as one binary glTF. Runs in browsers; GLTFExporter needs FileReader
// (and a canvas for textures).

import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { errorMessage, throwIfAborted } from "./errors";
import { formatBytes } from "./limits";
import type { LoadedModel } from "./loaders";
import type { ImportResources } from "./resources";

export interface DisplayScene {
  /** Wrapper holding the loaded scene: rotated upright and scaled to metres where known. */
  scene: THREE.Group;
  notes: string[];
}

type ClassicMaterial = THREE.Material & {
  color?: THREE.Color;
  map?: THREE.Texture | null;
  normalMap?: THREE.Texture | null;
  normalScale?: THREE.Vector2;
  normalMapType?: THREE.NormalMapTypes;
  bumpMap?: THREE.Texture | null;
  bumpScale?: number;
  emissive?: THREE.Color;
  emissiveMap?: THREE.Texture | null;
  emissiveIntensity?: number;
  alphaMap?: THREE.Texture | null;
  aoMap?: THREE.Texture | null;
  aoMapIntensity?: number;
  lightMap?: THREE.Texture | null;
  lightMapIntensity?: number;
  shininess?: number;
  vertexColors: boolean;
  flatShading?: boolean;
  wireframe?: boolean;
};

/** A PBR copy of a Phong, Lambert or Toon material (null for materials that are kept as they are). */
export function toStandardMaterial(material: THREE.Material): THREE.MeshStandardMaterial | null {
  if (material instanceof THREE.MeshStandardMaterial || material instanceof THREE.MeshBasicMaterial) return null;
  if (!(material instanceof THREE.MeshPhongMaterial || material instanceof THREE.MeshLambertMaterial || material instanceof THREE.MeshToonMaterial)) {
    return null;
  }
  const source = material as ClassicMaterial;
  const standard = new THREE.MeshStandardMaterial();
  standard.name = material.name;
  if (source.color) standard.color.copy(source.color);
  standard.map = source.map ?? null;
  standard.normalMap = source.normalMap ?? null;
  if (source.normalScale) standard.normalScale.copy(source.normalScale);
  if (source.normalMapType !== undefined) standard.normalMapType = source.normalMapType;
  standard.bumpMap = source.bumpMap ?? null;
  if (source.bumpScale !== undefined) standard.bumpScale = source.bumpScale;
  if (source.emissive) standard.emissive.copy(source.emissive);
  standard.emissiveMap = source.emissiveMap ?? null;
  if (source.emissiveIntensity !== undefined) standard.emissiveIntensity = source.emissiveIntensity;
  standard.alphaMap = source.alphaMap ?? null;
  standard.aoMap = source.aoMap ?? null;
  if (source.aoMapIntensity !== undefined) standard.aoMapIntensity = source.aoMapIntensity;
  standard.lightMap = source.lightMap ?? null;
  if (source.lightMapIntensity !== undefined) standard.lightMapIntensity = source.lightMapIntensity;
  // Blinn-Phong exponent to GGX roughness (Walter et al.'s mapping), kept away from mirror-like extremes.
  standard.roughness = source.shininess !== undefined ? Math.min(1, Math.max(0.25, Math.sqrt(2 / (source.shininess + 2)))) : 0.9;
  standard.metalness = 0;
  standard.opacity = material.opacity;
  standard.transparent = material.transparent;
  standard.alphaTest = material.alphaTest;
  standard.side = material.side;
  standard.vertexColors = source.vertexColors;
  standard.flatShading = source.flatShading ?? false;
  standard.wireframe = source.wireframe ?? false;
  standard.visible = material.visible;
  standard.depthWrite = material.depthWrite;
  return standard;
}

/** Prepares the loaded scene for the thumbnail and the preview GLB (it belongs to the analysis, so it is changed in place). */
export function prepareDisplay(model: LoadedModel, resources: ImportResources): DisplayScene {
  const notes: string[] = [];
  const extras: THREE.Object3D[] = [];
  model.root.traverse((node) => {
    if (node !== model.root && ((node as THREE.Light).isLight || (node as THREE.Camera).isCamera)) extras.push(node);
  });
  for (const node of extras) node.removeFromParent();
  if (extras.length > 0) notes.push("Lights and cameras from the file are not part of the preview.");

  const converted = new Map<THREE.Material, THREE.MeshStandardMaterial | null>();
  const convert = (material: THREE.Material): THREE.Material => {
    if (!converted.has(material)) {
      const standard = toStandardMaterial(material);
      if (standard) resources.trackMaterial(standard);
      converted.set(material, standard);
    }
    return converted.get(material) ?? material;
  };
  let computedNormals = false;
  model.root.traverse((node) => {
    node.userData = {};
    const mesh = node as Partial<THREE.Mesh>;
    if (mesh.geometry instanceof THREE.BufferGeometry) mesh.geometry.userData = {};
    if (!(node instanceof THREE.Mesh)) return;
    node.material = Array.isArray(node.material) ? node.material.map(convert) : convert(node.material);
    // Without normals a lit material renders black. Non-indexed geometry (FBX, STL) gets flat normals, as the formats
    // intend; indexed glTF geometry is left alone (GLTFLoader already shades it flat, as glTF requires).
    const geometry = node.geometry;
    if (geometry.index === null && geometry.hasAttribute("position") && !geometry.hasAttribute("normal")) {
      geometry.computeVertexNormals();
      computedNormals = true;
    }
  });
  if (computedNormals) notes.push("The file has no normals for some meshes; the preview shades them flat.");

  const scene = new THREE.Group();
  scene.name = "import";
  scene.rotation.x = model.uprightX;
  if (model.toMetres !== null && model.toMetres !== 1) scene.scale.setScalar(model.toMetres);
  scene.add(model.root);
  scene.updateMatrixWorld(true);
  return { scene, notes };
}

export interface DisplayGlb {
  glb: Blob | null;
  notes: string[];
}

const ATTEMPTS = [
  { maxTextureSize: 4096, animations: true },
  { maxTextureSize: 2048, animations: false },
  { maxTextureSize: 1024, animations: false },
] as const;

/** Binary glTF of the display scene, retried with smaller textures (and no animation) to fit `maxBytes`. */
export async function exportDisplayGlb(
  scene: THREE.Object3D,
  animations: THREE.AnimationClip[],
  maxBytes: number,
  signal?: AbortSignal,
): Promise<DisplayGlb> {
  const exporter = new GLTFExporter();
  for (const [index, attempt] of ATTEMPTS.entries()) {
    throwIfAborted(signal);
    let output: unknown;
    try {
      output = await exporter.parseAsync(scene, {
        binary: true,
        onlyVisible: true,
        maxTextureSize: attempt.maxTextureSize,
        animations: attempt.animations ? animations : [],
      });
    } catch (error) {
      return { glb: null, notes: [`No preview GLB could be made (${errorMessage(error)}); the original file is kept.`] };
    }
    if (!(output instanceof ArrayBuffer)) return { glb: null, notes: ["No preview GLB could be made; the original file is kept."] };
    if (output.byteLength <= maxBytes) {
      const notes = index > 0 ? [`The preview GLB uses textures of at most ${attempt.maxTextureSize} px${animations.length > 0 ? " and no animation" : ""} to stay within ${formatBytes(maxBytes)}.`] : [];
      return { glb: new Blob([output], { type: "model/gltf-binary" }), notes };
    }
  }
  return { glb: null, notes: [`A preview GLB would be larger than ${formatBytes(maxBytes)}, so only the original file is kept.`] };
}
