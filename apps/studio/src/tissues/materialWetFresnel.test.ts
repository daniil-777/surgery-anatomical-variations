import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { createTissueMaterial, dielectricInterfaceF0 } from "./material";
import type { TissueControls, TissueManifest } from "./contracts";
import type { TissueMaps } from "./assets";

const controls: TissueControls = { view: "surface", study: "lit", lighting: "camera", vessels: .7, fascia: .02, adipose: 0, wetness: .8, playing: false, time: 0, seed: 42 };
const manifest: TissueManifest = { schema: "viscera.tissue-materials/v1", resolution: [16, 16], recipe: { organ: "liver", seed: 42, tile_size_mm: 80, wetness: .8, vessel_opacity: .7, fascia_opacity: .02, adipose_opacity: 0 }, channels: {}, layers: [] };
function makeMaps(dry: boolean, editable = false) {
  return Object.fromEntries(["substrate", "normal", "roughness", "vessels", "fascia", "adipose", "wet_film", ...(dry ? ["substrate_roughness"] : []), ...(editable ? ["substrate_normal", "layer_relief"] : [])].map(name => [name, new THREE.Texture()])) as TissueMaps;
}
function shaderFor(material: THREE.Material) {
  const shader = { uniforms: {} as Record<string, { value: unknown }>, vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader };
  material.onBeforeCompile(shader as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
  return shader;
}
const coatComposition = "outgoingLight = outgoingLight * ( 1.0 - material.clearcoat * Fcc ) + ( clearcoatSpecularDirect + clearcoatSpecularIndirect ) * material.clearcoat;";

describe("authored wet dielectric interface ablation", () => {
  it("matches independent normal-incidence Fresnel boundary values and index matching", () => {
    expect(dielectricInterfaceF0(1, 1.333)).toBeCloseTo(.020373187841971414, 15);
    expect(dielectricInterfaceF0(1, 1.38)).toBeCloseTo(.02549254996116092, 15);
    expect(dielectricInterfaceF0(1.333, 1.38)).toBeCloseTo(.0003001208227467935, 15);
    expect(dielectricInterfaceF0(1.333, 1.333)).toBe(0);
    expect(dielectricInterfaceF0(1.38, 1.333)).toBe(dielectricInterfaceF0(1.333, 1.38));
  });
  it.each([NaN, Infinity, -Infinity, -1, 0, .99])("rejects invalid index %s on either side", value => {
    expect(() => dielectricInterfaceF0(value, 1.38)).toThrow(RangeError);
    expect(() => dielectricInterfaceF0(1.333, value)).toThrow(RangeError);
  });
  it("bounds interface and scalar coat weights across coverage and angle; this is not a full BRDF energy proof", () => {
    const coatF0 = .02037;
    const schlick = (f0: number, cosine: number) => f0 + (1 - f0) * (1 - cosine) ** 5;
    for (const substrateIor of [1.333, 1.38, 1.5, 1.6]) {
      const dry = dielectricInterfaceF0(1, substrateIor), wet = dielectricInterfaceF0(1.333, substrateIor);
      let previous = dry;
      for (let i = 0; i <= 100; i++) {
        const coverage = i / 100, base = dry * (1 - coverage) + wet * coverage;
        expect(Number.isFinite(base)).toBe(true); expect(base).toBeGreaterThanOrEqual(0); expect(base).toBeLessThanOrEqual(previous + 1e-14); previous = base;
        for (const cosine of [0, 1e-6, .05, .5, .9, 1]) {
          const coat = coverage * schlick(coatF0, cosine), substrate = schlick(base, cosine);
          const composed = substrate * (1 - coat) + coat;
          expect(Number.isFinite(composed)).toBe(true); expect(composed).toBeGreaterThanOrEqual(0); expect(composed).toBeLessThanOrEqual(1 + 1e-14);
          if (coverage === 0) expect(composed).toBe(substrate);
        }
      }
    }
  });
  it.each(["uv", "triplanar"] as const)("%s injects once before light accumulation, retains dry branch and Three's one coat composition", projection => {
    for (const { dry, editable } of [{ dry: false, editable: false }, { dry: true, editable: false }, { dry: true, editable: true }]) {
      const maps = makeMaps(dry, editable);
      const variantManifest = editable ? { ...manifest, channels: { layer_relief: { file: "layer_relief.png", color_space: "linear", packing: ["vessels", "adipose", "fascia"], decode_scale_mm: [.035, .45, .035], decode_offset_mm: [0, 0, 0] } } } : manifest;
      const set = createTissueMaterial(maps, variantManifest, controls, projection);
      try {
        const shader = shaderFor(set.physical), source = shader.fragmentShader;
        expect(shader.uniforms.tissueWetInterfaceF0).toBe(set.uniforms.tissueWetInterfaceF0);
        expect(set.physical.normalMap).toBe(editable ? maps.substrate_normal : maps.normal);
        expect(set.physical.customProgramCacheKey()).toContain(editable ? "editable" : "baked");
        if (editable) {
          expect(source).toContain("vec3 tissueCompositeNormal(vec2 uv)");
          expect(set.uniforms.tissueReliefScale.value.toArray()).toEqual([.035, .45, .035]);
        }
        expect(set.uniforms.tissueWetInterfaceF0.value).toBeCloseTo(.0003001208227467935, 15);
        const start = source.indexOf("#ifdef IOR\n            // Authored nested-interface");
        const end = source.indexOf("#endif", start), block = source.slice(start, end);
        expect(start).toBeGreaterThan(source.indexOf("#include <lights_physical_fragment>"));
        expect(start).toBeLessThan(source.indexOf("#include <lights_fragment_begin>"));
        expect(block).toContain("if (material.clearcoat > 0.0)");
        expect(block).toContain("specularColorFactor"); expect(block).toContain("specularIntensityFactor");
        expect(block).toContain("material.specularColor = mix(");
        expect(block).toContain("material.specularColorBlended = mix(");
        expect(block).not.toContain("outgoingLight ="); expect(block).not.toContain("reflectedLight.");
        expect(source.split("material.specularColor = mix(")).toHaveLength(2);
        expect(source.split(coatComposition)).toHaveLength(2);
        expect(source.slice(source.indexOf("vec3 outgoingLight ="))).toBe(THREE.ShaderLib.physical.fragmentShader.slice(THREE.ShaderLib.physical.fragmentShader.indexOf("vec3 outgoingLight =")));
        expect(source).toContain("material.clearcoatF0 = vec3(0.02037)");
        expect(source).toContain("max(material.clearcoatRoughness, clamp(tissueFilmRoughness, 0.06, 0.4))");
        expect(source.split("material.clearcoat *= tissueCoat")).toHaveLength(2);
        expect(set.physical.customProgramCacheKey()).toContain("wet-interface-ablation-v1");
        if (dry) expect(source).toContain("roughnessFactor = clamp(");
        else expect(source).toContain("Legacy manifest roughness is already baked");
      } finally { set.dispose(); Object.values(maps).forEach(texture => texture.dispose()); }
    }
  });
  it("guards the installed Three fields consumed by point/area lights and multiscattering", () => {
    const init = THREE.ShaderChunk.lights_physical_fragment, begin = THREE.ShaderChunk.lights_fragment_begin, bsdf = THREE.ShaderChunk.lights_physical_pars_fragment;
    expect(init).toContain("vec3 specularColorFactor"); expect(init).toContain("float specularIntensityFactor");
    expect(begin).toContain("material.multiScatteringCompensation = 1.0 + material.specularColorBlended");
    expect(bsdf).toContain("vec3 f0 = material.specularColorBlended");
    expect(bsdf).toContain("vec3 fresnel = ( material.specularColorBlended");
    expect(bsdf).toContain("computeMultiscattering( material.dfg, material.specularColor");
    expect(THREE.ShaderLib.physical.fragmentShader).toContain(coatComposition);
  });
  it("keeps maps, material identity, owner textures and diagnostics stable across wetness replay", () => {
    const maps = makeMaps(true), external = new THREE.Texture(), dispose = vi.spyOn(external, "dispose");
    const set = createTissueMaterial(maps, manifest, controls), lit = set.physical;
    const version = lit.version, key = lit.customProgramCacheKey(), coefficient = set.uniforms.tissueWetInterfaceF0;
    try {
      set.setSubstrate(external);
      for (const wetness of [0, .5, 1, 0, .8]) {
        expect(set.update({ ...controls, wetness })).toBe(lit);
        expect(set.uniforms.tissueWetness.value).toBe(wetness);
        expect(set.uniforms.tissueWetInterfaceF0).toBe(coefficient);
        expect(lit.version).toBe(version); expect(lit.customProgramCacheKey()).toBe(key);
        expect(lit.map).toBe(external); expect(lit.normalMap).toBe(maps.normal); expect(lit.roughnessMap).toBe(maps.substrate_roughness);
      }
      for (const study of ["albedo", "normal", "roughness"] as const) {
        const material = set.update({ ...controls, study });
        expect((material as THREE.MeshBasicMaterial).toneMapped).toBe(false);
        expect((material as THREE.MeshBasicMaterial).map).toBe(study === "albedo" ? external : maps[study]);
      }
      set.setSubstrate(undefined); expect(lit.map).toBe(maps.substrate);
      expect([lit.clearcoat, lit.ior, lit.metalness]).toEqual([1, 1.38, 0]);
    } finally { set.dispose(); expect(dispose).not.toHaveBeenCalled(); Object.values(maps).forEach(texture => texture.dispose()); external.dispose(); }
  });
});
