import { describe, expect, it } from "vitest";
import type { OrganMesh, SceneData } from "@viscera/render";
import fixture from "../../../tests/e2e/fixtures/atlas-material-v2.json";
import * as THREE from "three";
import { ATLAS_DISEASE_FIELD_VERSION, ATLAS_MATERIAL_SHADER_SHA256, ATLAS_MATERIAL_SHADER_VERSION, diseaseMaterialUniforms, installAtlasMaterial, readAtlasDiseaseField, readAtlasMaterial, type AtlasDiseaseField } from "./atlasMaterialShader";
import type { AtlasMaterialRecipe } from "./atlasMaterial";
const recipe = fixture.catalog.defaults.liver as AtlasMaterialRecipe;
function scene(): SceneData {
  return { organs: [{ id: "test", name: "Test", kind: "organ", color: "#804030", positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2],
    rest_positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], material_regions: [0, 0, 1] } as OrganMesh],
    metadata: { material_v2: { recipe: { ...recipe }, resolved: structuredClone(fixture.resolved.liver.balanced) } } };
}
describe("Material shader artifact validation", () => {
  it("keeps absent v1 materials separate from the v2 path", () => {
    const value = scene(); delete value.metadata;
    expect(readAtlasMaterial(value.organs[0]!, value)).toBeNull();
    expect(() => readAtlasMaterial(value.organs[0]!, value, recipe)).toThrow("no versioned material");
  });
  it("accepts matching rest attributes and exact shader identity", () => {
    const value = scene(); const definition = readAtlasMaterial(value.organs[0]!, value, recipe);
    expect(definition?.restPositions).toHaveLength(9);
    expect(definition?.regions).toEqual([0, 0, 1]);
    expect(definition?.resolved.uniforms.uAtlasSeed).toBe(recipe.seed);
  });
  it("refuses invalid coordinate payloads and region weights before rendering", () => {
    for (const patch of [{ rest_positions: [1, 2, 3] }, { rest_positions: [Infinity, 0, 0, 1, 0, 0, 0, 1, 0] }, { material_regions: [0, 2, 0] }]) {
      const value = scene(); Object.assign(value.organs[0]!, patch);
      expect(() => readAtlasMaterial(value.organs[0]!, value, recipe)).toThrow("aligned rest positions");
    }
  });
  it("refuses mismatched material recipes, shader sources and seeds", () => {
    const value = scene();
    expect(() => readAtlasMaterial(value.organs[0]!, value, { ...recipe, seed: 43 })).toThrow("differs from the requested");
    const definition = value.metadata!.material_v2 as { resolved: { shader_sha256: string; uniforms: { uAtlasSeed: number } } };
    definition.resolved.uniforms.uAtlasSeed = 99;
    expect(() => readAtlasMaterial(value.organs[0]!, value, recipe)).toThrow("do not match");
    definition.resolved.uniforms.uAtlasSeed = recipe.seed; definition.resolved.shader_sha256 = "modified-source";
    expect(() => readAtlasMaterial(value.organs[0]!, value, recipe)).toThrow("shader version does not match");
  });
});

const disease = (): AtlasDiseaseField => ({ version: ATLAS_DISEASE_FIELD_VERSION, fields: [{ center_mm: [1, 2, 3], radius_mm: 8, direction: [0, 0, 1], amplitude_mm: 0.5 }], target_srgb: [0.5, 0.3, 0.2], color_strength: 0.6 });
const diseaseScene = () => { const value = scene(); value.organs[0]!.metadata = { disease_field: disease() }; return value; };

describe("Disease appearance shader contract", () => {
  it("accepts only item-local fields and permits empty/zero-intensity fields", () => {
    const value = diseaseScene();
    expect(readAtlasMaterial(value.organs[0]!, value, recipe)?.diseaseField).toEqual(disease());
    value.metadata!.disease_field = disease(); delete value.organs[0]!.metadata;
    expect(readAtlasMaterial(value.organs[0]!, value, recipe)?.diseaseField).toBeUndefined();
    value.organs[0]!.metadata = { disease_field: { ...disease(), fields: [], color_strength: 0 } };
    expect(readAtlasDiseaseField(value.organs[0]!)?.fields).toEqual([]);
  });
  it("rejects malformed fields before material or geometry is accepted", () => {
    const field = disease().fields[0]!;
    const cases = [
      { ...disease(), version: "unknown" }, { ...disease(), fields: Array(49).fill(field) },
      { ...disease(), color_strength: NaN }, { ...disease(), color_strength: 1.1 },
      { ...disease(), target_srgb: [0, Infinity, 1] }, { ...disease(), target_srgb: [0, 0, -0.1] },
      ...[{ center_mm: [NaN, 0, 0] }, { radius_mm: 0 }, { radius_mm: 1e-50 }, { radius_mm: Infinity },
        { direction: [0, 0] }, { direction: [0, 0, NaN] }, { amplitude_mm: NaN }, { amplitude_mm: -1 }]
        .map(patch => ({ ...disease(), fields: [{ ...field, ...patch }] })),
    ];
    for (const invalid of cases) {
      const value = diseaseScene(); value.organs[0]!.metadata!.disease_field = invalid;
      expect(() => readAtlasMaterial(value.organs[0]!, value, recipe)).toThrow("disease appearance field");
      delete value.metadata;
      expect(() => readAtlasMaterial(value.organs[0]!, value)).toThrow("disease appearance field");
    }
  });
  it("passes at most 48 rest-space supports and converts sRGB targets to linear", () => {
    const uniforms = diseaseMaterialUniforms(disease());
    expect(uniforms.uAtlasDiseaseCount!.value).toBe(1);
    expect(uniforms.uAtlasDiseaseSites!.value).toHaveLength(48);
    expect(uniforms.uAtlasDiseaseSites!.value[0].toArray()).toEqual([1, 2, 3, 8]);
    expect(uniforms.uAtlasDiseaseTargetLinear!.value.x).toBeCloseTo(0.21404114, 7);
    expect(uniforms.uAtlasDiseaseStrength!.value).toBe(0.6);
  });
  it("adds only the disease color blend and preserves base roughness and microdetail", () => {
    const compile = (value: SceneData) => {
      const definition = readAtlasMaterial(value.organs[0]!, value, recipe)!;
      const material = new THREE.MeshPhysicalMaterial();
      const geometry = new THREE.BufferGeometry();
      installAtlasMaterial(geometry, material, definition);
      const shader = { vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader, uniforms: {} } as Parameters<typeof material.onBeforeCompile>[0];
      material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
      return { material, geometry, shader };
    };
    const base = compile(scene()), modified = compile(diseaseScene());
    expect(base.material.customProgramCacheKey()).toBe(`${ATLAS_MATERIAL_SHADER_VERSION}:${ATLAS_MATERIAL_SHADER_SHA256}`);
    expect(base.shader.fragmentShader).not.toContain("uAtlasDisease");
    expect(modified.material.customProgramCacheKey()).toContain(ATLAS_DISEASE_FIELD_VERSION);
    expect(modified.shader.fragmentShader).toContain("mask = max(mask, support * support * support)");
    expect(modified.shader.fragmentShader).toContain("atlasDiseaseMask(vAtlasRestPosition) * uAtlasDiseaseStrength");
    expect(modified.shader.fragmentShader).toContain("roughnessFactor = atlasSurface.roughness");
    expect(modified.shader.fragmentShader).toContain("atlasSurface.heightGradientRest");
    expect(modified.shader.vertexShader).toEqual(base.shader.vertexShader);
    expect(modified.geometry.getAttribute("atlasRestPosition").array).toEqual(base.geometry.getAttribute("atlasRestPosition").array);
    base.geometry.dispose(); modified.geometry.dispose(); base.material.dispose(); modified.material.dispose();
  });
});
