import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { sampleMaterialField } from "../atlasMaterialSampler";
import { CUTTING_APPEARANCE, createCuttingDrapeMaterial, createCuttingReflectionEnvironment, createCuttingSurfaceMaterial } from "./appearance";

const rest = [0, 0, 0, 1, 0, 0, 0, 1, 0];
function triangle() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(rest, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute([1, .5, .5, 1, .5, .5, 1, .5, .5], 3));
  geometry.setIndex([0, 1, 2]); geometry.computeVertexNormals(); return geometry;
}

describe("authored cutting appearance", () => {
  it("keeps shader detail attached to rest coordinates without changing geometry or source colours", () => {
    const geometry = triangle(), originalColors = geometry.getAttribute("color").array.slice();
    const supplied = [...rest];
    const material = createCuttingSurfaceMaterial(geometry, supplied);
    expect(Array.from(geometry.getAttribute("position").array)).toEqual(rest);
    expect(geometry.getAttribute("color").array).toEqual(originalColors);
    expect(material.vertexColors).toBe(false);
    geometry.getAttribute("position").setX(0, 6); supplied[0] = 99;
    expect(Array.from(geometry.getAttribute("atlasRestPosition").array)).toEqual(rest);
    expect(material.userData.appearance.patientLearned).toBe(false);
    expect(material.userData.appearance.geometryModified).toBe(false);
    geometry.dispose(); material.dispose();
  });

  it("uses the shared colour, roughness and filtered micronormal shader for both exposed surfaces", () => {
    for (const surface of ["capsule", "cut"] as const) {
      const geometry = triangle(), material = createCuttingSurfaceMaterial(geometry, rest, surface);
      const shader = { vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader, uniforms: {} } as Parameters<typeof material.onBeforeCompile>[0];
      material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
      expect(shader.fragmentShader).toContain("roughnessFactor = atlasSurface.roughness");
      expect(shader.fragmentShader).toContain("atlasSurface.heightGradientRest");
      expect(shader.fragmentShader).toContain("atlasFootprintMm");
      const color = shader.uniforms.uAtlasBaseColor!.value as THREE.Vector3;
      // Linear-light, dark red/brown diffuse design. This does not certify the
      // final tone-mapped result, which still requires native render review.
      expect(color.x).toBeGreaterThan(color.y * 2);
      expect(color.x).toBeLessThan(.2);
      expect(color.y).toBeLessThan(.06);
      expect(shader.uniforms.uAtlasFineScaleMm!.value).toBe(.48);
      expect(shader.uniforms.uAtlasHeightAmplitudeMm!.value).toBe(.024);
      geometry.dispose(); material.dispose();
    }
  });

  it("attenuates subpixel roughness and normal detail rather than aliasing in wide views", () => {
    const points = Array.from({ length: 64 }, (_, i) => [i * .137, i * .229, i * .107]).flat();
    const close = sampleMaterialField(CUTTING_APPEARANCE.recipes.capsule, points, null, .01);
    const distant = sampleMaterialField(CUTTING_APPEARANCE.recipes.capsule, points, null, 10);
    expect(Math.max(...close.roughness) - Math.min(...close.roughness)).toBeGreaterThan(.002);
    expect(Math.max(...distant.roughness) - Math.min(...distant.roughness)).toBeLessThan(1e-12);
    expect(Math.max(...close.gradient.map(Math.abs))).toBeGreaterThan(.001);
    expect(Math.max(...distant.gradient.map(Math.abs))).toBe(0);
  });

  it("rejects misaligned or nonfinite rest coordinates before adding shader attributes", () => {
    const geometry = triangle();
    for (const invalid of [[0, 0, 0], [...rest.slice(0, -1), NaN]]) {
      expect(() => createCuttingSurfaceMaterial(geometry, invalid)).toThrow("rest millimetres");
      expect(geometry.getAttribute("atlasRestPosition")).toBeUndefined();
    }
    geometry.dispose();
  });

  it("cleans reflection resources once and uses a neutral matte support", () => {
    const environment = createCuttingReflectionEnvironment();
    const disposals: ReturnType<typeof vi.fn>[] = [];
    environment.scene.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      for (const resource of [object.geometry, object.material as THREE.Material]) {
        const listener = vi.fn(); resource.addEventListener("dispose", listener); disposals.push(listener);
      }
    });
    environment.dispose(); environment.dispose();
    expect(disposals.length).toBeGreaterThan(0);
    for (const listener of disposals) expect(listener).toHaveBeenCalledTimes(1);
    expect(environment.scene.children).toHaveLength(0);
    const floor = createCuttingDrapeMaterial();
    expect(floor.roughness).toBeGreaterThan(.9);
    expect(Math.abs(floor.color.g - floor.color.b)).toBeLessThan(.01);
    floor.dispose();
  });
});
