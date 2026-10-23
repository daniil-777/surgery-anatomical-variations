import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { SceneNavigationGuard, currentSceneBounds, navigationAngles, navigationDirection, navigationStep } from "./wholeSceneNavigation";

const bounds = new THREE.Box3(new THREE.Vector3(-1000, -1000, -1000), new THREE.Vector3(1000, 1000, 1000));
const wall = () => { const geometry = new THREE.PlaneGeometry(100, 100); geometry.computeBoundingBox(); return geometry; };
describe("between-organ camera guard", () => {
  it("continuously stops a long motion before a two-sided thin sheet, and permits retreat", () => {
    const geometry = wall(), guard = new SceneNavigationGuard(() => [{ id: "sheet", visible: true, geometry }]);
    for (const sign of [-1, 1]) {
      const start = new THREE.Vector3(0, 0, sign * 100), hit = guard.move(start, new THREE.Vector3(0, 0, -sign * 100), bounds);
      expect(hit.blockedBy).toBe("sheet"); expect(hit.position.z * sign).toBeCloseTo(2.02, 5);
      const retreat = guard.move(hit.position, start, bounds);
      expect(retreat.blocked).toBe(false); expect(retreat.position.equals(start)).toBe(true);
    }
    geometry.dispose();
  });
  it("checks triangle edges and respects hidden geometry without treating whole bounding boxes as walls", () => {
    const geometry = wall(); let visible = true;
    const guard = new SceneNavigationGuard(() => [{ id: "sheet", visible, geometry }]);
    expect(guard.move(new THREE.Vector3(51, 0, 10), new THREE.Vector3(51, 0, -10), bounds).blocked).toBe(true);
    expect(guard.move(new THREE.Vector3(53, 0, 10), new THREE.Vector3(53, 0, -10), bounds).blocked).toBe(false);
    visible = false;
    expect(guard.move(new THREE.Vector3(0, 0, 10), new THREE.Vector3(0, 0, -10), bounds).blocked).toBe(false);
    geometry.dispose();
  });
  it("rebuilds contact geometry after a source revision and clamps only requested translation", () => {
    const geometry = wall(), guard = new SceneNavigationGuard(() => [{ id: "sheet", visible: true, geometry }]);
    expect(guard.closest(new THREE.Vector3(0, 0, 1))?.distanceMm).toBe(1);
    geometry.translate(0, 0, 20); geometry.computeBoundingBox(); guard.invalidate();
    expect(guard.closest(new THREE.Vector3(0, 0, 1))).toBeNull();
    expect(guard.closest(new THREE.Vector3(0, 0, 21))?.distanceMm).toBe(1);
    const step = guard.move(new THREE.Vector3(200, 200, 200), new THREE.Vector3(5000, 200, 200), bounds);
    expect(step.position.toArray()).toEqual([1000, 200, 200]); expect(step.blockedBy).toBe("navigation bounds");
    expect(() => guard.move(new THREE.Vector3(NaN, 0, 0), new THREE.Vector3(), bounds)).toThrow();
    geometry.dispose();
  });
});
describe("inspection camera frame and scene bounds", () => {
  it("keeps all-direction looking finite and computes unambiguous local movement", () => {
    for (const yaw of [-Math.PI, 0, Math.PI / 2, Math.PI]) for (const pitch of [-Math.PI / 2, 0, Math.PI / 2]) {
      const forward = navigationDirection(yaw, pitch), angles = navigationAngles(forward);
      expect(navigationDirection(angles.yaw, angles.pitch).distanceTo(forward)).toBeLessThan(1e-12);
      const step = navigationStep("right", forward, 10);
      expect(step.length()).toBeCloseTo(10, 10); expect(step.dot(forward)).toBeCloseTo(0, 10);
    }
    expect(navigationStep("forward", new THREE.Vector3(0, 0, -1), 10).toArray()).toEqual([0, 0, -10]);
    expect(() => navigationStep("forward", new THREE.Vector3(), 10)).toThrow();
    expect(() => navigationDirection(NaN, 0)).toThrow();
  });
  it("updates aggregate bounds after a deformed mesh changes its extent", () => {
    const a = new THREE.BoxGeometry(2, 4, 6), b = new THREE.BoxGeometry(2, 2, 2);
    b.translate(10, 0, 0); const initial = currentSceneBounds([a, b]);
    expect(initial.max.x).toBe(11);
    b.translate(20, 0, 0); b.computeBoundingBox();
    currentSceneBounds([a, b], initial);
    expect(initial.min.toArray()).toEqual([-1, -2, -3]); expect(initial.max.x).toBe(31);
    a.dispose(); b.dispose();
  });
});
