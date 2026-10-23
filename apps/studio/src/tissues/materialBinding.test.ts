import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { createTissueMaterial } from "./material";
import type { TissueControls, TissueManifest } from "./contracts";
import type { TissueMaps } from "./assets";

const controls: TissueControls = { view: "surface", study: "lit", lighting: "camera", vessels: .7, fascia: .02, adipose: 0, wetness: .8, playing: false, time: 0, seed: 42 };
const manifest: TissueManifest = { schema: "viscera.tissue-materials/v1", resolution: [16, 16], recipe: { organ: "liver", seed: 42, tile_size_mm: 80, wetness: .8, vessel_opacity: .7, fascia_opacity: .02, adipose_opacity: 0 }, channels: {}, layers: [] };

describe("externally owned appearance binding", () => {
  it.each(["uv", "triplanar"] as const)("%s swaps and restores only RGB without rebuilding materials or disposing owner textures", projection => {
    const maps = Object.fromEntries(["substrate", "normal", "roughness", "vessels", "fascia", "adipose", "wet_film"].map(name => [name, new THREE.Texture()])) as TissueMaps;
    const first = new THREE.Texture(), second = new THREE.Texture();
    const dispose = [maps.substrate, first, second].map(texture => vi.spyOn(texture, "dispose"));
    const set = createTissueMaterial(maps, manifest, controls, projection);
    const lit = set.physical, albedo = set.update({ ...controls, study: "albedo" }) as THREE.MeshBasicMaterial;
    const versions = [lit.version, albedo.version], keys = [lit.customProgramCacheKey(), albedo.customProgramCacheKey()];
    for (const texture of [first, second, undefined, first, undefined]) {
      set.setSubstrate(texture);
      expect(lit.map).toBe(texture ?? maps.substrate); expect(albedo.map).toBe(texture ?? maps.substrate);
      expect(set.update(controls)).toBe(lit); expect(set.update({ ...controls, study: "albedo" })).toBe(albedo);
      expect([lit.version, albedo.version]).toEqual(versions);
      expect([lit.customProgramCacheKey(), albedo.customProgramCacheKey()]).toEqual(keys);
      expect(lit.normalMap).toBe(maps.normal); expect(lit.roughnessMap).toBe(maps.roughness);
    }
    set.dispose(); dispose.forEach(spy => expect(spy).not.toHaveBeenCalled());
    Object.values(maps).forEach(texture => texture.dispose()); first.dispose(); second.dispose();
  });
});
