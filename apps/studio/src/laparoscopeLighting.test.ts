import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { LAPAROSCOPE_EMITTERS, LaparoscopeLighting, laparoscopeIrradiance } from "./laparoscopeLighting";

describe("camera-attached fiber illumination", () => {
  it("obeys inverse-square distance, grazing incidence and directional falloff", () => {
    expect(laparoscopeIrradiance(40) / laparoscopeIrradiance(80)).toBe(4);
    expect(laparoscopeIrradiance(40, 1, .5)).toBe(laparoscopeIrradiance(40) / 2);
    expect(laparoscopeIrradiance(40, .8)).toBeLessThan(laparoscopeIrradiance(40));
    expect(laparoscopeIrradiance(40, 1, -1)).toBe(0);
    for (const d of [0, -1, NaN, Infinity]) expect(laparoscopeIrradiance(d)).toBe(0);
  });
  it("conserves source intensity and keeps both emitters attached through camera roll", () => {
    const scene = new THREE.Scene(), primary = new THREE.SpotLight(), rig = new LaparoscopeLighting(scene, primary), camera = new THREE.PerspectiveCamera();
    camera.position.set(19, -32, 247); camera.rotation.set(.2, -.3, 1.2); camera.updateMatrixWorld();
    expect(rig.update(camera, 155000)).toBe(true);
    expect(rig.lights.reduce((s, l) => s + l.intensity, 0)).toBeCloseTo(155000);
    rig.lights.forEach((light, i) => {
      const local = camera.worldToLocal(light.position.clone());
      expect(local.distanceTo(new THREE.Vector3().fromArray(LAPAROSCOPE_EMITTERS[i]!.offsetMm))).toBeLessThan(1e-10);
      expect(light.target.position.clone().sub(light.position).normalize().distanceTo(camera.getWorldDirection(new THREE.Vector3()))).toBeLessThan(1e-10);
      expect(light.castShadow).toBe(true); expect(light.decay).toBe(2);
    });
    expect(rig.update(camera, 155000)).toBe(false);
    camera.rotateY(.2); expect(rig.update(camera, 155000)).toBe(true);
    rig.update(camera, 0); expect(rig.lights.every(l => l.intensity === 0)).toBe(true);
    rig.dispose(); expect(scene.children).toHaveLength(0);
  });
});
