import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { fitLiverView, liverBoundsCorners, liverInCameraFrame } from "./liverPlaygroundView";

describe("explicit liver camera framing", () => {
  it.each([.36, 1, 2.8])("fits a displaced deformed body at aspect %s without moving it or rotating the camera", aspect => {
    const camera = new THREE.PerspectiveCamera(38, aspect, 1, 8000);
    camera.position.set(400, 450, 600); camera.lookAt(0, 60, 0); camera.updateMatrixWorld();
    const bounds = new THREE.Box3(new THREE.Vector3(700, 1400, -300), new THREE.Vector3(1060, 1490, -30));
    const original = bounds.clone(), rotation = camera.quaternion.clone();
    expect(liverInCameraFrame(camera, bounds)).toBe(false);
    const center = fitLiverView(camera, bounds);
    expect(center.distanceTo(bounds.getCenter(new THREE.Vector3()))).toBeLessThan(1e-10);
    expect(bounds.equals(original)).toBe(true);
    expect(camera.quaternion.angleTo(rotation)).toBeLessThan(1e-7);
    for (const corner of liverBoundsCorners(bounds)) {
      corner.project(camera);
      expect(Math.abs(corner.x)).toBeLessThanOrEqual(1 / 1.18 + 1e-12);
      expect(Math.abs(corner.y)).toBeLessThanOrEqual(1 / 1.18 + 1e-12);
      expect(corner.z).toBeGreaterThan(-1); expect(corner.z).toBeLessThan(1);
    }
    expect(liverInCameraFrame(camera, bounds)).toBe(true);
  });
  it("rejects invalid bounds and lens input", () => {
    const camera = new THREE.PerspectiveCamera(38, 1, 1, 8000);
    expect(() => fitLiverView(camera, new THREE.Box3())).toThrow();
    expect(() => fitLiverView(camera, new THREE.Box3(new THREE.Vector3(-Infinity, 0, 0), new THREE.Vector3(1, 1, 1)))).toThrow();
    camera.aspect = 0;
    expect(() => fitLiverView(camera, new THREE.Box3(new THREE.Vector3(), new THREE.Vector3(1, 1, 1)))).toThrow();
  });
});
