import * as THREE from "three";
import { resolveMaterial } from "../atlasLocal";
import { ATLAS_MATERIAL_VERSION, type AtlasMaterialRecipe } from "../atlasMaterial";
import { ATLAS_MATERIAL_SHADER_SHA256, ATLAS_MATERIAL_SHADER_VERSION, installAtlasMaterial, type AtlasMaterialDefinition } from "../atlasMaterialShader";

export type CuttingSurface = "capsule" | "cut";

// Appearance is intentionally independent of the source mesh's display colours
// and of learned mechanics. These values are authored design controls, not tissue
// measurements. Reusing the atlas resolver keeps CPU and GPU field units aligned.
const capsule: AtlasMaterialRecipe = Object.freeze({
  version: ATLAS_MATERIAL_VERSION, organ: "liver", preset: "rich", seed: 20261020,
  tint: .15, pigment_contrast: .56, mottle_scale_mm: 8,
  wetness: .78, fine_detail: .10, structure_strength: .08,
});
const cut: AtlasMaterialRecipe = Object.freeze({
  ...capsule, tint: .55, wetness: .94, fine_detail: .78,
  pigment_contrast: .84, mottle_scale_mm: 3.5, structure_strength: .48,
});

export const CUTTING_APPEARANCE = Object.freeze({
  schema: "viscera.cutting-appearance/v1",
  label: "Authored liver appearance · reference geometry",
  source: "authored-atlas-liver-material",
  opticalValidation: "NOT_RUN",
  patientLearned: false,
  geometryModified: false,
  coordinates: "template_rest_mm",
  detail: "Analytic shading normals and roughness; no measured capsule microstructure",
  shaderVersion: ATLAS_MATERIAL_SHADER_VERSION,
  shaderSha256: ATLAS_MATERIAL_SHADER_SHA256,
  recipes: Object.freeze({ capsule, cut }),
  // The source colours remain in the reference artifact for provenance. They do
  // not modulate this shader: a categorical source colour is not tissue albedo.
  usesSourceDisplayColors: false,
});

/** Starting points for native visual review, not an optically calibrated rig. */
export const CUTTING_LIGHTING = Object.freeze({
  background: "#171d20", exposure: .95,
  hemisphere: Object.freeze({ sky: "#e4e9eb", ground: "#373b3d", intensity: .8 }),
  key: Object.freeze({ color: "#fff8f1", intensity: 2.1 }),
  fill: Object.freeze({ color: "#d9e3e8", intensity: .45 }),
  pmremSigma: .015,
});

/** Install the existing atlas material in undeformed millimetres. Each cap side
 * needs its own geometry/rest array; the shared field then remains continuous
 * across the cut and follows material points as either side moves. */
export function createCuttingSurfaceMaterial(
  geometry: THREE.BufferGeometry,
  restPositionsMm: ArrayLike<number>,
  surface: CuttingSurface = "capsule",
): THREE.MeshPhysicalMaterial {
  const count = geometry.getAttribute("position")?.count;
  if (!count || restPositionsMm.length !== count * 3 ||
      !Array.from(restPositionsMm).every(value => Number.isFinite(value) && Math.abs(value) <= 100000)) {
    throw new Error("Cutting appearance requires finite rest millimetres aligned with every surface vertex");
  }
  if (surface !== "capsule" && surface !== "cut") throw new Error("Unsupported cutting surface");
  const recipe = CUTTING_APPEARANCE.recipes[surface];
  // resolveMaterial is the established browser implementation of the versioned
  // atlas resolver. Its public return is broad because it carries extra metadata.
  const resolved = resolveMaterial(recipe) as AtlasMaterialDefinition["resolved"];
  const material = new THREE.MeshPhysicalMaterial({
    name: `cutting-authored-${surface}`, side: THREE.DoubleSide,
    roughness: surface === "capsule" ? .36 : .28,
    envMapIntensity: surface === "capsule" ? .55 : .52,
    clearcoat: surface === "capsule" ? .28 : .72,
    clearcoatRoughness: surface === "capsule" ? .22 : .18,
    emissive: surface === "capsule" ? new THREE.Color("#000000") : new THREE.Color("#260303"),
    emissiveIntensity: surface === "capsule" ? 0 : .32,
    ior: 1.4,
  });
  installAtlasMaterial(geometry, material, {
    recipe, resolved, restPositions: Array.from(restPositionsMm), regions: new Array<number>(count).fill(0),
  });
  material.userData = { appearance: CUTTING_APPEARANCE, surface };
  return material;
}

/** Neutral, matte support: avoids the previous cyan cast and preserves a visible
 * contact shadow. This is a presentation support, not a simulated surgical drape. */
export function createCuttingDrapeMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ name: "cutting-neutral-support", color: "#454c4d", roughness: .96, metalness: 0 });
}

/** Compact reflection studio for PMREMGenerator.fromScene(scene, sigma).
 * Narrow bright cards separated by dark neutral surroundings give the steel
 * bevel and wet capsule a readable reflection without a giant white window.
 * This scene is used only to bake illumination, never inserted into the organ
 * scene. Dispose it after PMREM generation; dispose the returned render target
 * separately with the renderer's other resources. */
export function createCuttingReflectionEnvironment(): { scene: THREE.Scene; dispose: () => void } {
  const scene = new THREE.Scene(); scene.name = "cutting-authored-reflection-studio";
  // A diffuse neutral room keeps polished vertical faces legible even when
  // their mirror direction misses the narrower overhead strips.
  scene.background = new THREE.Color("#70777c");
  const geometries: THREE.BufferGeometry[] = [], materials: THREE.Material[] = [];
  const addCard = (name: string, width: number, height: number, position: [number, number, number], radiance: number) => {
    const geometry = new THREE.PlaneGeometry(width, height);
    const material = new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(radiance, radiance, radiance), side: THREE.DoubleSide, toneMapped: false });
    const card = new THREE.Mesh(geometry, material); card.name = name;
    card.position.set(...position); card.lookAt(0, 0, 0); scene.add(card);
    geometries.push(geometry); materials.push(material);
  };
  addCard("overhead-strip", 380, 65, [-220, 330, 170], 8);
  addCard("side-strip", 70, 310, [280, 150, -120], 5);
  addCard("instrument-reflection-strip", 55, 280, [300, -230, -180], 3);
  addCard("rear-soft-fill", 180, 70, [-150, 70, -310], 2.5);
  let disposed = false;
  return { scene, dispose() {
    if (disposed) return; disposed = true;
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    scene.clear();
  } };
}
