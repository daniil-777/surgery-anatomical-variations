import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { loadTissueMaps, materialAssets, type TissueMaps } from "./assets";
import { createTissueMaterial } from "./material";
import { createCapture, validateCapture } from "./capture";
import { createScopeLighting } from "./lighting";
import { serializeDisplayRecipe, type TissueControls, type TissueManifest } from "./contracts";

const manifest: TissueManifest = { schema: "viscera.tissue-materials/v1", resolution: [16, 16], recipe: { organ: "colonic_mucosa", seed: 42, tile_size_mm: 80, wetness: .8, vessel_opacity: .7, fascia_opacity: .02, adipose_opacity: 0 }, channels: Object.fromEntries(["substrate", "normal", "roughness"].map(key => [key, { file: `${key}.png`, color_space: key === "substrate" ? "srgb" : "linear" }])), layers: ["vessels", "fascia", "adipose", "wet_film"].map(id => ({ id, file: `overlays/${id}.png`, opacity: 1 })) };
const controls: TissueControls = { vessels: .7, fascia: .02, adipose: 0, wetness: .8, study: "lit", view: "walkthrough", playing: false, time: 0, seed: 42, lighting: "camera" };
function texture(size = 16) { const value = new THREE.Texture({ width: size, height: size }); vi.spyOn(value, "dispose"); return value; }

afterEach(() => vi.unstubAllGlobals());
describe("transactional tissue assets", () => {
  it("rejects malformed manifest and every asset path before requesting any file", async () => {
    for (const file of ["../private.png", "https://elsewhere/a.png", "/tmp/a.png", "a.png?token=x", "x/%2e.png"]) {
      const load = vi.fn();
      await expect(loadTissueMaps({ ...manifest, channels: { ...manifest.channels, normal: { file, color_space: "linear" } } }, "/test", 8, new AbortController().signal, load)).rejects.toThrow();
      expect(load).not.toHaveBeenCalled();
    }
    expect(() => materialAssets({ ...manifest, resolution: [16, 17] })).toThrow();
    expect(() => materialAssets({ ...manifest, recipe: { ...manifest.recipe, wetness: NaN } })).toThrow();
  });
  it("releases partial successes after one asset fails, including late successes", async () => {
    const created: THREE.Texture[] = [];
    await expect(loadTissueMaps(manifest, "/test", 8, new AbortController().signal, async url => {
      if (url.endsWith("normal.png")) throw new Error("HTTP 404");
      await Promise.resolve(); const value = texture(); created.push(value); return value;
    })).rejects.toThrow("HTTP 404");
    expect(created).toHaveLength(6); created.forEach(value => expect(value.dispose).toHaveBeenCalledTimes(1));
  });
  it("rejects wrong pixel dimensions and releases the rejected texture", async () => {
    const created: THREE.Texture[] = [];
    await expect(loadTissueMaps(manifest, "/test", 8, new AbortController().signal, async url => { const value = texture(url.endsWith("normal.png") ? 32 : 16); created.push(value); return value; })).rejects.toThrow("dimensions");
    created.forEach(value => expect(value.dispose).toHaveBeenCalledTimes(1));
  });
  it("cancels stale loads and disposes a valid set exactly once", async () => {
    const abort = new AbortController(), stale: THREE.Texture[] = [];
    const pending = loadTissueMaps(manifest, "/test", 16, abort.signal, async () => { const value = texture(); stale.push(value); await Promise.resolve(); return value; });
    abort.abort(); await expect(pending).rejects.toThrow("cancelled");
    stale.forEach(value => expect(value.dispose).toHaveBeenCalledTimes(1));
    const set = await loadTissueMaps(manifest, "/test", 16, new AbortController().signal, async () => texture());
    expect(set.maps.substrate.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(set.maps.normal.colorSpace).toBe(THREE.NoColorSpace);
    expect(set.maps.wet_film.colorSpace).toBe(THREE.NoColorSpace);
    expect(set.maps.normal.anisotropy).toBe(8);
    set.dispose(); set.dispose(); Object.values(set.maps).forEach(value => expect(value.dispose).toHaveBeenCalledTimes(1));
  });
});
describe("independent tissue optical layers", () => {
  it("updates shared uniforms through zero wetness without shader or material churn", () => {
    const maps = Object.fromEntries(materialAssets(manifest).map(asset => [asset.key, texture()])) as TissueMaps;
    const set = createTissueMaterial(maps, manifest, controls), physical = set.update(controls), version = physical.version;
    const changed = { ...controls, wetness: 0, vessels: .2, fascia: .8, adipose: .5 };
    expect(set.update(changed)).toBe(physical);
    expect(set.uniforms.tissueCoverage.value.toArray()).toEqual([.2, .8, .5]);
    expect(set.uniforms.tissueWetness.value).toBe(0);
    expect(physical.version).toBe(version);
    const study = set.update({ ...controls, study: "albedo" });
    expect(set.update(controls)).toBe(physical); expect(set.update({ ...controls, study: "albedo" })).toBe(study);
    expect(set.physical.clearcoatNormalScale.x).toBeLessThan(set.physical.normalScale.x);
    set.dispose(); Object.values(maps).forEach(value => value.dispose());
  });
  it("scope emitters follow camera rigidly with finite area and target in front", () => {
    const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
    camera.position.set(40, -8, 100); camera.lookAt(60, 15, 150); camera.updateMatrixWorld();
    const rig = createScopeLighting(scene); rig.update(camera, controls, new THREE.Vector3());
    const areas = scene.children.filter(x => x instanceof THREE.RectAreaLight) as THREE.RectAreaLight[];
    expect(areas).toHaveLength(2);
    areas.forEach(area => { expect(area.width * area.height).toBeGreaterThan(5); expect(area.position.distanceTo(camera.position)).toBeLessThan(5); expect(area.quaternion.equals(camera.quaternion)).toBe(true); });
    rig.dispose(); expect(scene.children).toHaveLength(0);
  });
});
describe("4K capture resource lifecycle", () => {
  function mockRenderer(fail = false) {
    let width = 640, height = 480, ratio = 1.5;
    const value = { getSize: (v: THREE.Vector2) => v.set(width, height), getPixelRatio: () => ratio, setPixelRatio: (n: number) => { ratio = n; }, setSize: (w: number, h: number) => { width = w; height = h; }, domElement: { toDataURL: () => { if (fail) throw new Error("encode failed"); return `${width}x${height}`; }, captureStream: () => { throw new Error("stream unavailable"); } } };
    return value as unknown as THREE.WebGLRenderer;
  }
  it("restores resolution, DPR, camera aspect and time after still success or failure", () => {
    for (const fail of [false, true]) {
      const renderer = mockRenderer(fail), camera = new THREE.PerspectiveCamera(58, 4 / 3), draw = vi.fn();
      const service = createCapture(renderer, camera, draw, () => 7, () => true);
      if (fail) expect(() => service.capture(3840, 2160, 12)).toThrow("encode failed");
      else expect(service.capture(3840, 2160, 12)).toBe("3840x2160");
      expect(renderer.getSize(new THREE.Vector2()).toArray()).toEqual([640, 480]); expect(renderer.getPixelRatio()).toBe(1.5);
      expect(camera.aspect).toBe(4 / 3); expect(draw.mock.calls).toEqual([[12], [7]]); service.dispose();
    }
  });
  it("restores interactive state when captureStream throws before encoder creation", async () => {
    vi.stubGlobal("MediaRecorder", { isTypeSupported: () => true });
    const renderer = mockRenderer(), camera = new THREE.PerspectiveCamera(58, 4 / 3), service = createCapture(renderer, camera, () => {}, () => 0, () => true);
    await expect(service.record()).rejects.toThrow("stream unavailable");
    expect(service.recording).toBe(false); expect(renderer.getSize(new THREE.Vector2()).toArray()).toEqual([640, 480]); expect(camera.aspect).toBe(4 / 3); service.dispose();
  });
  it("rejects unbounded or invalid captures before touching WebGL", () => {
    for (const values of [[Infinity, 2160, 0], [3840, -1, 0], [16384, 16384, 0], [3840, 2160, NaN], [512.5, 512, 0]]) expect(() => validateCapture(values[0]!, values[1]!, values[2]!)).toThrow();
    expect(() => validateCapture(3840, 2160, 0)).not.toThrow();
  });
});

describe("editable relief metadata", () => {
  const editable = () => ({ ...manifest, channels: { ...manifest.channels,
    substrate_normal: { file: "substrate_normal.png", color_space: "linear" },
    layer_relief: { file: "layer_relief.png", color_space: "linear", packing: ["vessels", "adipose", "fascia"], decode_scale_mm: [.035, .45, .035], decode_offset_mm: [0, 0, 0] },
  } });
  it("requires paired normals and relief with an explicit physical channel order", () => {
    expect(materialAssets(editable())).toHaveLength(9);
    const partial = editable(); delete (partial.channels as Record<string, unknown>).substrate_normal;
    expect(() => materialAssets(partial)).toThrow("Incomplete");
    const reversed = editable(); reversed.channels.layer_relief.packing.reverse();
    expect(() => materialAssets(reversed)).toThrow("packing");
    const invalid = editable(); invalid.channels.layer_relief.decode_scale_mm[1] = NaN;
    expect(() => materialAssets(invalid)).toThrow("packing");
  });
  it("composes normals for both tangent shading and the separate coat with declared height units", () => {
    const source = editable(), maps = Object.fromEntries(materialAssets(source).map(asset => [asset.key, texture()])) as TissueMaps;
    const set = createTissueMaterial(maps, source, controls);
    const shader = { uniforms: {}, fragmentShader: "#include <normal_fragment_maps>\n#include <clearcoat_normal_fragment_maps>\n#include <lights_physical_fragment>" };
    set.physical.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
    expect(shader.fragmentShader).not.toContain("texture2D( normalMap, vNormalMapUv )");
    expect(shader.fragmentShader).not.toContain("texture2D( clearcoatNormalMap, vClearcoatNormalMapUv )");
    expect(set.uniforms.tissueReliefScale.value.toArray()).toEqual([.035, .45, .035]);
    expect(set.uniforms.tissueTileMm.value).toBe(80);
    expect(set.uniforms.tissueTexel.value).toBe(1 / 16);
    set.dispose(); Object.values(maps).forEach(value => value.dispose());
  });
});

describe("interrupted resource and shader regressions", () => {
  it("releases decoded textures immediately even if a sibling request never settles", async () => {
    const controller = new AbortController(), created: THREE.Texture[] = [];
    let finishLate: ((value: THREE.Texture) => void) | undefined;
    const pending = loadTissueMaps(manifest, "/test", 8, controller.signal, url => {
      if (url.endsWith("normal.png")) return new Promise(resolve => { finishLate = resolve; });
      const value = texture(); created.push(value); return Promise.resolve(value);
    });
    await Promise.resolve(); await Promise.resolve();
    controller.abort(); await expect(pending).rejects.toThrow("cancelled");
    expect(created).toHaveLength(6); created.forEach(value => expect(value.dispose).toHaveBeenCalledTimes(1));
    const late = texture(); finishLate!(late); await Promise.resolve(); await Promise.resolve();
    expect(late.dispose).toHaveBeenCalledTimes(1);
  });
  it("separates all diagnostic shader cache entries and preserves raw data display", () => {
    const maps = Object.fromEntries(materialAssets(manifest).map(asset => [asset.key, texture()])) as TissueMaps;
    const set = createTissueMaterial(maps, manifest, controls);
    const materials = (["lit", "albedo", "normal", "roughness"] as const).map(study => set.update({ ...controls, study }));
    expect(new Set(materials.map(material => material.customProgramCacheKey())).size).toBe(4);
    for (const study of ["normal", "roughness"] as const) {
      const material = set.update({ ...controls, study }), shader = { uniforms: {}, fragmentShader: "#include <colorspace_fragment>" };
      material.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
      expect(shader.fragmentShader).not.toContain("#include <colorspace_fragment>");
      expect((material as THREE.MeshBasicMaterial).fog).toBe(false);
    }
    set.dispose(); Object.values(maps).forEach(value => value.dispose());
  });
});

describe("lossless material recipe download", () => {
  it("exports exact learned-model replay metadata without serializing the GPU texture", () => {
    const appearance = { modelId: "e".repeat(64), condition: "human:liver", region: "liver", seed: "18446744073709551615",
      resolution: 256, evidence: "research_trained", texture: { toJSON() { throw new Error("GPU resources are not serializable"); } } };
    const exported = JSON.parse(serializeDisplayRecipe('{"recipe":{"seed":42}}', controls, "", appearance));
    expect(exported.learnedAppearance).toMatchObject({ modelId: appearance.modelId, seed: appearance.seed, resolution: 256, pbrGroundTruth: false });
    expect(exported.learnedAppearance).not.toHaveProperty("texture");
    expect(JSON.parse(serializeDisplayRecipe("{}", controls, "")).learnedAppearance).toBeNull();
  });
  it("retains uint64 number tokens and safely serializes display text", () => {
    const source = '{"recipe":{"seed":18446744073709551615},"provenance":{"seed_decimal":"18446744073709551615"}}';
    const exported = serializeDisplayRecipe(source, controls, 'Review "wet" tissue\nnext frame');
    expect(exported).toContain('"seed":18446744073709551615');
    expect(JSON.parse(exported).note).toBe('Review "wet" tissue\nnext frame');
    expect(JSON.parse(exported).display).toEqual(controls);
    expect(() => serializeDisplayRecipe("null", controls, "")).toThrow();
    expect(() => serializeDisplayRecipe("{broken", controls, "")).toThrow();
  });
});
