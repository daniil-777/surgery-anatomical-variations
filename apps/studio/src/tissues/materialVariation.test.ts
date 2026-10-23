import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { createTissueMaterial } from "./material";
import { serializeDisplayRecipe, type TissueControls, type TissueManifest, type TissueStudy } from "./contracts";
import type { TissueMaps } from "./assets";
import { applyMaterialRoughnessVariation, defaultMaterialVariation, materialSeedOffsets, newMaterialSeed, tissueVariationShader, validateMaterialVariation, type TissueMaterialVariation } from "./materialVariation";

const controls: TissueControls = { view: "surface", study: "lit", lighting: "camera", vessels: .7, fascia: .02, adipose: 0, wetness: .8, playing: false, time: 0, seed: 42 };
const manifest: TissueManifest = {
  schema: "viscera.tissue-materials/v1", resolution: [16, 16],
  recipe: { organ: "liver", seed: 42, tile_size_mm: 80, wetness: .8, vessel_opacity: .7, fascia_opacity: .02, adipose_opacity: 0 },
  channels: { layer_relief: { file: "layer_relief.png", color_space: "linear", packing: ["vessels", "adipose", "fascia"], decode_scale_mm: [.035, .45, .035], decode_offset_mm: [0, 0, 0] } }, layers: [],
};
const studies: TissueStudy[] = ["lit", "albedo", "normal", "roughness"];
function makeMaps() {
  return Object.fromEntries(["substrate", "normal", "roughness", "vessels", "fascia", "adipose", "wet_film", "substrate_normal", "substrate_roughness", "layer_relief"].map(name => [name, new THREE.Texture()])) as TissueMaps;
}
function shaderFor(material: THREE.Material) {
  // Use each real installed Three template, including the basic diagnostic shaders.
  const template = material instanceof THREE.MeshPhysicalMaterial ? THREE.ShaderLib.physical : THREE.ShaderLib.basic;
  const shader = { uniforms: {} as Record<string, { value: unknown }>, vertexShader: template.vertexShader, fragmentShader: template.fragmentShader };
  material.onBeforeCompile(shader as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
  return shader;
}
function mainBody(source: string) {
  const start = source.indexOf("void main()");
  expect(start).toBeGreaterThanOrEqual(0);
  return source.slice(start);
}

afterEach(() => vi.unstubAllGlobals());

describe("material variation recipes and full-width replay seeds", () => {
  it("preserves uint64 text through validation and export; high bits change shader offsets", () => {
    const seeds = ["0", "42", "4294967338", "9007199254740992", "9007199254740993", "18446744073709551615"];
    const offsets = seeds.map(seed => {
      const variation = { ...defaultMaterialVariation, enabled: true, seed };
      expect(validateMaterialVariation(variation).seed).toBe(seed);
      expect(JSON.parse(serializeDisplayRecipe("{}", { ...controls, materialVariation: variation }, "")).display.materialVariation.seed).toBe(seed);
      const values = materialSeedOffsets(seed);
      expect(materialSeedOffsets(seed)).toEqual(values);
      for (const value of values) {
        expect(Number.isFinite(value)).toBe(true); expect(value).toBeGreaterThanOrEqual(0); expect(value).toBeLessThan(256);
        expect(Math.fround(value)).toBe(value);
      }
      return values;
    });
    // Pairs differ only in upper32 bits or below Number precision, respectively.
    expect(offsets[1]).not.toEqual(offsets[2]); expect(offsets[3]).not.toEqual(offsets[4]);
    expect(new Set(offsets.map(value => JSON.stringify(value))).size).toBe(seeds.length);
    // Fixed SplitMix64 zero-state reference outputs end in cdaf,65f4,454f.
    expect(offsets[0]).toEqual([0xcdaf / 256, 0x65f4 / 256, 0x454f / 256]);
  });

  it.each(["", " ", " 42", "42 ", "042", "-1", "+1", "1.0", "1e3", "0x2a", "NaN", "Infinity", "18446744073709551616", "999999999999999999999", 42, NaN, null])("rejects noncanonical or out-of-range seed %s", seed => {
    const invalid = { ...defaultMaterialVariation, seed } as TissueMaterialVariation;
    expect(() => validateMaterialVariation(invalid)).toThrow(RangeError);
    expect(() => materialSeedOffsets(seed as string)).toThrow(RangeError);
  });

  it("rejects unsupported versions, nonboolean switches and nonfinite or out-of-range parameters", () => {
    for (const change of [{ version: "viscera-tissue-variation-v2" }, { enabled: 1 }, { enabled: "false" },
      ...["strength", "roughness"].flatMap(key => [-.001, 1.001, NaN, Infinity, -Infinity, "0.5"].map(value => ({ [key]: value }))),
      ...["warmth", "depth"].flatMap(key => [-1.001, 1.001, NaN, Infinity, -Infinity, "0"].map(value => ({ [key]: value })))]) {
      expect(() => validateMaterialVariation({ ...defaultMaterialVariation, ...change } as TissueMaterialVariation)).toThrow(RangeError);
    }
    for (const limit of [0, 1]) expect(() => validateMaterialVariation({ ...defaultMaterialVariation, strength: limit, roughness: limit, warmth: limit ? 1 : -1, depth: limit ? -1 : 1 })).not.toThrow();
  });

  it("packs both cryptographic words exactly without rounding or signed coercion", () => {
    const cases: Array<[number, number, string]> = [[0, 0, "0"], [0, 42, "42"], [1, 42, "4294967338"], [0xffffffff, 0xffffffff, "18446744073709551615"]];
    for (const [high, low, expected] of cases) {
      const getRandomValues = vi.fn((words: Uint32Array) => {
        expect(words).toBeInstanceOf(Uint32Array); expect(words).toHaveLength(2);
        words.set([high, low]); return words;
      });
      vi.stubGlobal("crypto", { getRandomValues });
      const seed = newMaterialSeed();
      expect(seed).toBe(expected); expect(getRandomValues).toHaveBeenCalledTimes(1);
      expect(() => validateMaterialVariation({ ...defaultMaterialVariation, seed })).not.toThrow();
    }
  });
});

describe("stable material variation uniforms and shader integration", () => {
  it("keeps zero roughness variation exactly neutral across the full imported range", () => {
    for (const dry of [0, .001, .05, .075, .2, .5, .85, .95, .999, 1]) {
      for (const field of [-1, -.4, 0, .4, 1]) expect(applyMaterialRoughnessVariation(dry, field, 0)).toBe(dry);
      for (const amount of [.1, .5, 1]) expect(applyMaterialRoughnessVariation(dry, 0, amount)).toBe(dry);
    }
  });

  it("preserves imported roughness endpoints and bounds the signed variation without increasing extremes", () => {
    expect(applyMaterialRoughnessVariation(0, -1, 1)).toBe(0);
    expect(applyMaterialRoughnessVariation(0, 1, 1)).toBe(.16);
    expect(applyMaterialRoughnessVariation(1, -1, 1)).toBe(.84);
    expect(applyMaterialRoughnessVariation(1, 1, 1)).toBe(1);
    expect(applyMaterialRoughnessVariation(.05, -1, 1)).toBe(.05);
    expect(applyMaterialRoughnessVariation(.95, 1, 1)).toBe(.95);
    expect(applyMaterialRoughnessVariation(.8, 1, 1)).toBe(.85);
    expect(applyMaterialRoughnessVariation(.1, -1, 1)).toBe(.075);
    for (let index = 0; index <= 100; index++) {
      const dry = index / 100;
      for (const amount of [0, .1, .5, 1]) {
        let previous = -Infinity;
        for (const field of [-1, -.5, 0, .5, 1]) {
          const varied = applyMaterialRoughnessVariation(dry, field, amount);
          expect(varied).toBeGreaterThanOrEqual(0); expect(varied).toBeLessThanOrEqual(1);
          expect(varied).toBeGreaterThanOrEqual(previous); previous = varied;
          expect(Math.abs(varied - dry)).toBeLessThanOrEqual(.16 * amount + 1e-15);
          if (field < 0) expect(varied).toBeLessThanOrEqual(dry);
          if (field > 0) expect(varied).toBeGreaterThanOrEqual(dry);
        }
      }
    }
  });

  it("rejects invalid numeric roughness contracts instead of clamping malformed inputs", () => {
    for (const value of [NaN, Infinity, -Infinity]) {
      expect(() => applyMaterialRoughnessVariation(value, 0, 0)).toThrow(RangeError);
      expect(() => applyMaterialRoughnessVariation(.5, value, 0)).toThrow(RangeError);
      expect(() => applyMaterialRoughnessVariation(.5, 0, value)).toThrow(RangeError);
    }
    for (const value of [-.001, 1.001]) {
      expect(() => applyMaterialRoughnessVariation(value, 0, 0)).toThrow(RangeError);
      expect(() => applyMaterialRoughnessVariation(.5, 0, value)).toThrow(RangeError);
    }
    for (const value of [-1.001, 1.001]) expect(() => applyMaterialRoughnessVariation(.5, value, 1)).toThrow(RangeError);
  });

  it.each(["uv", "triplanar"] as const)("%s updates every study without replacing materials, maps, uniforms or shader programs", projection => {
    const maps = makeMaps(), set = createTissueMaterial(maps, manifest, controls, projection);
    try {
      const materials = studies.map(study => set.update({ ...controls, study }));
      const versions = materials.map(material => material.version), keys = materials.map(material => material.customProgramCacheKey());
      const callbacks = materials.map(material => material.onBeforeCompile), uniforms = { ...set.uniforms };
      const vectorSeed = set.uniforms.tissueVariationSeed.value, vectorAmounts = set.uniforms.tissueVariationAmounts.value;
      for (const seed of ["42", "43", "18446744073709551615", "42"]) {
        const variation = { ...defaultMaterialVariation, enabled: true, seed, warmth: -.3, depth: .2, strength: .65, roughness: .7 };
        studies.forEach((study, index) => {
          const material = set.update({ ...controls, study, materialVariation: variation });
          expect(material).toBe(materials[index]); expect(material.version).toBe(versions[index]);
          expect(material.customProgramCacheKey()).toBe(keys[index]); expect(material.onBeforeCompile).toBe(callbacks[index]);
          const shader = shaderFor(material);
          for (const [name, uniform] of Object.entries(uniforms)) expect(shader.uniforms[name]).toBe(uniform);
        });
        expect(set.uniforms.tissueVariationEnabled.value).toBe(1);
        expect(set.uniforms.tissueVariationSeed.value).toBe(vectorSeed); expect(vectorSeed.toArray()).toEqual(materialSeedOffsets(seed));
        expect(set.uniforms.tissueVariationAmounts.value).toBe(vectorAmounts); expect(vectorAmounts.toArray()).toEqual([-.3, .2, .65, .7]);
        expect(set.physical.map).toBe(maps.substrate); expect(set.physical.normalMap).toBe(maps.substrate_normal); expect(set.physical.roughnessMap).toBe(maps.substrate_roughness);
      }
      set.update(controls);
      expect(set.uniforms.tissueVariationEnabled.value).toBe(0);
      expect(set.uniforms.tissueVariationSeed.value.toArray()).toEqual(materialSeedOffsets("42"));
      expect(Object.isFrozen(defaultMaterialVariation)).toBe(true);
      expect(defaultMaterialVariation).toEqual({ version: "viscera-tissue-variation-v1", enabled: false, seed: "42", strength: .45, warmth: 0, depth: 0, roughness: .35 });
    } finally { set.dispose(); Object.values(maps).forEach(texture => texture.dispose()); }
  });

  it("rejects an invalid update before changing appearance or existing layer uniforms", () => {
    const maps = makeMaps(), set = createTissueMaterial(maps, manifest, controls);
    try {
      const before = { coverage: set.uniforms.tissueCoverage.value.toArray(), wetness: set.uniforms.tissueWetness.value, seed: set.uniforms.tissueVariationSeed.value.toArray(), amounts: set.uniforms.tissueVariationAmounts.value.toArray() };
      expect(() => set.update({ ...controls, vessels: .1, wetness: 0, materialVariation: { ...defaultMaterialVariation, enabled: true, depth: NaN } })).toThrow(RangeError);
      expect({ coverage: set.uniforms.tissueCoverage.value.toArray(), wetness: set.uniforms.tissueWetness.value, seed: set.uniforms.tissueVariationSeed.value.toArray(), amounts: set.uniforms.tissueVariationAmounts.value.toArray() }).toEqual(before);
    } finally { set.dispose(); Object.values(maps).forEach(texture => texture.dispose()); }
  });

  it.each(["uv", "triplanar"] as const)("%s shares pigment and roughness functions between lit and diagnostic paths, keeping normal output independent", projection => {
    const maps = makeMaps(), set = createTissueMaterial(maps, manifest, controls, projection);
    try {
      const shaders = Object.fromEntries(studies.map(study => [study, shaderFor(set.update({ ...controls, study }))]));
      const bodies = Object.fromEntries(studies.map(study => [study, mainBody(shaders[study]!.fragmentShader)]));
      const position = projection === "triplanar" ? "vTissueVariationPosition / tissueVariationTileMm" : "vTissueVariationPosition";
      for (const study of ["lit", "albedo"] as const) {
        const body = bodies[study]!;
        expect(body.match(/tissueVaryPigment\(/g)).toHaveLength(1);
        expect(body).toContain(`tissueVaryPigment(diffuseColor.rgb, ${position})`);
        expect(body.indexOf("tissueVaryPigment(")).toBeLessThan(body.indexOf("vec4 tv ="));
      }
      expect(bodies.lit).toContain(`roughnessFactor = tissueVaryRoughness(roughnessFactor, ${position})`);
      expect(bodies.roughness).toContain("float dryRoughness = tissueVaryRoughness(");
      expect(bodies.roughness).toContain(`.r, ${position})`);
      // Variations act on the dry substrate before the existing single wet-film composition.
      expect(bodies.lit!.indexOf("roughnessFactor = tissueVaryRoughness")).toBeLessThan(bodies.lit!.indexOf("roughnessFactor = clamp"));
      expect(bodies.roughness!.indexOf("tissueVaryRoughness(")).toBeLessThan(bodies.roughness!.indexOf("float filmCover"));
      expect(bodies.normal).not.toMatch(/tissueVary(?:Pigment|Roughness)\(/);
      expect(bodies.normal).not.toContain("tissueVariation");
      for (const study of studies) {
        expect(shaders[study]!.vertexShader).toContain(`vTissueVariationPosition = ${projection === "triplanar" ? "position" : "vec3(uv, 0.0)"}`);
        expect(shaders[study]!.fragmentShader).toContain(tissueVariationShader);
      }
      // This checks the exact-disabled integration branch; actual pixel neutrality is browser-tested.
      expect(tissueVariationShader).toMatch(/vec3 tissueVaryPigment[^]*?if \(tissueVariationEnabled == 0\.0\) return color;\s*float field/);
      expect(tissueVariationShader).toMatch(/float tissueVaryRoughness[^]*?if \(tissueVariationEnabled == 0\.0\) return dry;\s*if \(tissueVariationAmounts.w == 0\.0\) return dry;\s*float field/);
      expect(tissueVariationShader).toContain("clamp(dry + 0.16*tissueVariationAmounts.w*field, min(dry, 0.075), max(dry, 0.85))");
    } finally { set.dispose(); Object.values(maps).forEach(texture => texture.dispose()); }
  });
});
