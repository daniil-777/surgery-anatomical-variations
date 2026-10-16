import * as THREE from "three";
import type { OrganMesh, SceneData } from "@viscera/render";
import materialGLSL from "./atlas-material-field.glsl?raw";
import contract from "./atlas-material-field.json";
import { sameAtlasMaterial, validateAtlasMaterial, type AtlasMaterialRecipe } from "./atlasMaterial";

export const ATLAS_MATERIAL_SHADER_VERSION = contract.version;
export const ATLAS_MATERIAL_SHADER_SHA256 = contract.sha256;
export const ATLAS_MATERIAL_GLSL = materialGLSL;
export const ATLAS_DISEASE_FIELD_VERSION = "disease-morphology-design-1.0.0" as const;
export const ATLAS_DISEASE_FIELD_VERSION_V2 = "disease-morphology-design-2.0.0" as const;
export const ATLAS_DISEASE_MAX_FIELDS = 48;
export interface AtlasDiseaseField {
  version: typeof ATLAS_DISEASE_FIELD_VERSION | typeof ATLAS_DISEASE_FIELD_VERSION_V2;
  fields: { center_mm: [number, number, number]; radius_mm: number; direction: [number, number, number]; amplitude_mm: number }[];
  target_srgb: [number, number, number];
  color_strength: number;
}
export interface AtlasMaterialDefinition {
  recipe: AtlasMaterialRecipe;
  resolved: {
    shader_version: string;
    shader_sha256: string;
    uniforms: Record<string, number | number[]>;
    clearcoat: number;
    clearcoat_roughness: number;
    metalness: number;
    geometry_modified: false;
  };
  diseaseField?: AtlasDiseaseField;
  restPositions: number[];
  regions: number[];
}
const scalarUniforms = ["uAtlasSeed", "uAtlasPigmentContrast", "uAtlasMottleScaleMm", "uAtlasWetness", "uAtlasFineDetail", "uAtlasStructureStrength", "uAtlasRoughnessBase", "uAtlasPigmentAmplitude", "uAtlasFineScaleMm", "uAtlasHeightAmplitudeMm", "uAtlasStructureScaleMm", "uAtlasStructureMode"];
const vectorUniforms = ["uAtlasBaseColor", "uAtlasLigamentColor", "uAtlasStructureStretch"];
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const finiteArray = (value: unknown, count: number): value is number[] => Array.isArray(value) && value.length === count && value.every((item) => typeof item === "number" && Number.isFinite(item));

/** Disease appearance is item-local and uses the undeformed template coordinate frame. */
export function readAtlasDiseaseField(organ: OrganMesh): AtlasDiseaseField | undefined {
  const value = organ.metadata?.disease_field;
  if (value === undefined || value === null) return undefined;
  if (!object(value) || (value.version !== ATLAS_DISEASE_FIELD_VERSION && value.version !== ATLAS_DISEASE_FIELD_VERSION_V2) || !Array.isArray(value.fields) || value.fields.length > ATLAS_DISEASE_MAX_FIELDS ||
      !finiteArray(value.target_srgb, 3) || value.target_srgb.some(channel => channel < 0 || channel > 1) ||
      typeof value.color_strength !== "number" || !Number.isFinite(value.color_strength) || value.color_strength < 0 || value.color_strength > 1)
    throw new Error("The disease appearance field is invalid or unsupported.");
  for (const field of value.fields) {
    if (!object(field) || !finiteArray(field.center_mm, 3) || field.center_mm.some(axis => Math.abs(axis) > 100000) ||
        !finiteArray(field.direction, 3) || field.direction.some(axis => Math.abs(axis) > 1.00001) ||
        typeof field.radius_mm !== "number" || !Number.isFinite(field.radius_mm) || field.radius_mm < 0.000001 || field.radius_mm > 100000 ||
        typeof field.amplitude_mm !== "number" || !Number.isFinite(field.amplitude_mm) || field.amplitude_mm < 0 || field.amplitude_mm > 100000)
      throw new Error("The disease appearance field needs finite centers, radii, directions and amplitudes.");
  }
  return value as unknown as AtlasDiseaseField;
}

/** Validate rest-space fields before buffers or shaders can reach the renderer. */
export function readAtlasMaterial(organ: OrganMesh, scene: SceneData, expected?: AtlasMaterialRecipe): AtlasMaterialDefinition | null {
  const diseaseField = readAtlasDiseaseField(organ);
  const definition = organ.metadata?.material_v2 ?? scene.metadata?.material_v2;
  if (definition === undefined || definition === null) {
    if (expected) throw new Error("The tissue preview has no versioned material definition.");
    return null;
  }
  if (!object(definition) || !object(definition.resolved)) throw new Error("The tissue material definition is invalid.");
  validateAtlasMaterial(definition.recipe);
  if (expected && !sameAtlasMaterial(expected, definition.recipe)) throw new Error("The preview surface differs from the requested material recipe.");
  const resolved = definition.resolved;
  if (resolved.shader_version !== ATLAS_MATERIAL_SHADER_VERSION || resolved.shader_sha256 !== ATLAS_MATERIAL_SHADER_SHA256 || resolved.geometry_modified !== false)
    throw new Error("This tissue shader version does not match the anatomy server. Reload after updating Studio.");
  if (!object(resolved.uniforms)) throw new Error("The tissue material has no shader parameters.");
  const uniforms = resolved.uniforms;
  for (const key of scalarUniforms) if (typeof uniforms[key] !== "number" || !Number.isFinite(uniforms[key]))
    throw new Error(`The tissue shader parameter ${key} is invalid.`);
  for (const key of vectorUniforms) if (!finiteArray(uniforms[key], 3)) throw new Error(`The tissue shader parameter ${key} is invalid.`);
  if (uniforms.uAtlasSeed !== definition.recipe.seed || ![0, 1, 2].includes(Number(uniforms.uAtlasStructureMode)) ||
      ["uAtlasMottleScaleMm", "uAtlasFineScaleMm", "uAtlasStructureScaleMm"].some((key) => Number(uniforms[key]) <= 0))
    throw new Error("The tissue shader parameters do not match the material recipe.");
  for (const key of ["clearcoat", "clearcoat_roughness", "metalness"]) if (typeof resolved[key] !== "number" || !Number.isFinite(resolved[key]) || resolved[key] < 0 || resolved[key] > 1)
    throw new Error("The tissue finish parameters are invalid.");
  const arrays = organ as unknown as Record<string, unknown>;
  if (!finiteArray(arrays.rest_positions, organ.positions.length) || arrays.rest_positions.some((value) => Math.abs(value) > 100000) ||
      !finiteArray(arrays.material_regions, organ.positions.length / 3) || arrays.material_regions.some((value) => value < 0 || value > 1))
    throw new Error("The tissue preview needs finite, aligned rest positions and material regions.");
  return { ...(diseaseField ? { diseaseField } : {}), recipe: definition.recipe, resolved: resolved as unknown as AtlasMaterialDefinition["resolved"], restPositions: arrays.rest_positions, regions: arrays.material_regions };
}

export function materialUniforms(values: Record<string, number | number[]>): Record<string, THREE.IUniform> {
  return Object.fromEntries([...scalarUniforms, ...vectorUniforms].map((key) => {
    const value = values[key]!;
    return [key, { value: Array.isArray(value) ? new THREE.Vector3(...value as [number, number, number]) : value }];
  }));
}

const fragmentInputs = `
varying vec3 vAtlasRestPosition;
varying float vAtlasMaterialRegion;
${materialGLSL}
// Physical rest-mm height gradient pulled into the deformed surface tangent plane.
// This changes fragment lighting only; vertex position and silhouette stay intact.
vec3 atlasPerturbNormal(vec3 surfacePosition, vec3 surfaceNormal, vec3 heightGradientRest, float faceOrientation) {
  vec3 dx = dFdx(surfacePosition), dy = dFdy(surfacePosition);
  vec3 r1 = cross(dy, surfaceNormal), r2 = cross(surfaceNormal, dx);
  float determinant = dot(dx, r1) * faceOrientation;
  // Relative cosine test is invariant to screen/UV derivative scale.
  // Preserve the source normal where its tangent frame is singular.
  if (abs(determinant) <= length(cross(dx, dy)) * 1e-7) return surfaceNormal;
  vec2 heightDerivative = vec2(dot(heightGradientRest, dFdx(vAtlasRestPosition)), dot(heightGradientRest, dFdy(vAtlasRestPosition)));
  vec3 gradient = sign(determinant) * (heightDerivative.x * r1 + heightDerivative.y * r2);
  return normalize(abs(determinant) * surfaceNormal - gradient);
}
`;

const diseaseFragmentInputs = `
uniform int uAtlasDiseaseCount;
uniform vec4 uAtlasDiseaseSites[48];
uniform vec3 uAtlasDiseaseTargetLinear;
uniform float uAtlasDiseaseStrength;
float atlasDiseaseMask(vec3 restPosition) {
  float mask = 0.0;
  for (int i = 0; i < 48; ++i) {
    if (i >= uAtlasDiseaseCount) break;
    vec3 offset = (restPosition - uAtlasDiseaseSites[i].xyz) / uAtlasDiseaseSites[i].w;
    float support = max(1.0 - dot(offset, offset), 0.0);
    mask = max(mask, support * support * support);
  }
  return mask;
}
`;
export function diseaseMaterialUniforms(field: AtlasDiseaseField): Record<string, THREE.IUniform> {
  // Explicit sRGB conversion keeps CPU/baked appearance and physical shading aligned.
  const target = new THREE.Color().setRGB(...field.target_srgb, THREE.SRGBColorSpace);
  const sites = Array.from({ length: ATLAS_DISEASE_MAX_FIELDS }, (_, index) => {
    const site = field.fields[index];
    return site ? new THREE.Vector4(...site.center_mm, site.radius_mm) : new THREE.Vector4(0, 0, 0, 1);
  });
  return { uAtlasDiseaseCount: { value: field.fields.length }, uAtlasDiseaseSites: { value: sites },
    uAtlasDiseaseTargetLinear: { value: new THREE.Vector3(target.r, target.g, target.b) }, uAtlasDiseaseStrength: { value: field.color_strength } };
}

export function installAtlasMaterial(geometry: THREE.BufferGeometry, material: THREE.MeshPhysicalMaterial, definition: AtlasMaterialDefinition): void {
  geometry.setAttribute("atlasRestPosition", new THREE.Float32BufferAttribute(definition.restPositions, 3));
  geometry.setAttribute("atlasMaterialRegion", new THREE.Float32BufferAttribute(definition.regions, 1));
  material.vertexColors = false;
  material.color.setRGB(1, 1, 1);
  material.clearcoat = definition.resolved.clearcoat;
  material.clearcoatRoughness = definition.resolved.clearcoat_roughness;
  material.metalness = definition.resolved.metalness;
  material.customProgramCacheKey = () => `${ATLAS_MATERIAL_SHADER_VERSION}:${ATLAS_MATERIAL_SHADER_SHA256}${definition.diseaseField ? `:${ATLAS_DISEASE_FIELD_VERSION}` : ""}`;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, materialUniforms(definition.resolved.uniforms));
    if (definition.diseaseField) Object.assign(shader.uniforms, diseaseMaterialUniforms(definition.diseaseField));
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec3 atlasRestPosition;\nattribute float atlasMaterialRegion;\nvarying vec3 vAtlasRestPosition;\nvarying float vAtlasMaterialRegion;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvAtlasRestPosition = atlasRestPosition;\nvAtlasMaterialRegion = atlasMaterialRegion;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${fragmentInputs}${definition.diseaseField ? diseaseFragmentInputs : ""}`)
      .replace("#include <color_fragment>", `#include <color_fragment>
        float atlasFootprintMm = max(length(dFdx(vAtlasRestPosition)), length(dFdy(vAtlasRestPosition)));
        AtlasMaterialSample atlasSurface = atlasSampleMaterial(vAtlasRestPosition, vAtlasMaterialRegion, atlasFootprintMm);
        ${definition.diseaseField ? "atlasSurface.colorLinear = mix(atlasSurface.colorLinear, uAtlasDiseaseTargetLinear, atlasDiseaseMask(vAtlasRestPosition) * uAtlasDiseaseStrength);\n        " : ""}diffuseColor.rgb = atlasSurface.colorLinear;`)
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor = atlasSurface.roughness;")
      .replace("#include <normal_fragment_maps>", "#include <normal_fragment_maps>\nnormal = atlasPerturbNormal(-vViewPosition, normal, atlasSurface.heightGradientRest, faceDirection);")
      .replace("#include <clearcoat_normal_fragment_maps>", "#include <clearcoat_normal_fragment_maps>\n#ifdef USE_CLEARCOAT\nclearcoatNormal = atlasPerturbNormal(-vViewPosition, clearcoatNormal, atlasSurface.heightGradientRest, faceDirection);\n#endif");
  };
  material.needsUpdate = true;
}
