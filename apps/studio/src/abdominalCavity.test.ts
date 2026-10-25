import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { createAbdominalCavityGeometry } from "./abdominalCavity";
import { SceneNavigationGuard } from "./wholeSceneNavigation";

describe("insufflated cavity enclosure", () => {
  it("is a closed welded two-manifold with inward triangles and finite smooth normals", () => {
    const geometry = createAbdominalCavityGeometry(), p = geometry.getAttribute("position"), n = geometry.getAttribute("normal"), index = geometry.index!;
    const edges = new Map<string, { count: number; orientation: number }>();
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), cross = new THREE.Vector3();
    let signedVolume = 0;
    for (let face = 0; face < index.count; face += 3) {
      const ids = [index.getX(face), index.getX(face + 1), index.getX(face + 2)];
      a.fromBufferAttribute(p, ids[0]!); b.fromBufferAttribute(p, ids[1]!); c.fromBufferAttribute(p, ids[2]!);
      signedVolume += a.dot(cross.crossVectors(b, c)) / 6;
      expect(cross.subVectors(b, a).cross(c.clone().sub(a)).lengthSq()).toBeGreaterThan(1e-5);
      for (let k = 0; k < 3; k++) {
        const first = ids[k]!, second = ids[(k + 1) % 3]!, key = [Math.min(first, second), Math.max(first, second)].join(":");
        const edge = edges.get(key) ?? { count: 0, orientation: 0 };
        edge.count++; edge.orientation += first < second ? 1 : -1; edges.set(key, edge);
      }
    }
    for (const edge of edges.values()) { expect(edge.count).toBe(2); expect(edge.orientation).toBe(0); }
    expect(p.count - edges.size + index.count / 3).toBe(2);
    expect(signedVolume).toBeLessThan(-30_000_000);
    for (let i = 0; i < p.count; i++) {
      a.fromBufferAttribute(p, i); b.fromBufferAttribute(n, i);
      expect([...a.toArray(), ...b.toArray()].every(Number.isFinite)).toBe(true);
      expect(b.length()).toBeCloseTo(1, 5);
      // Every surface points into its star-shaped cavity, including the poles.
      expect(b.dot(a.sub(new THREE.Vector3(0, -6, 38)))).toBeLessThan(-90);
    }
    geometry.dispose();
  });

  it("surrounds the scope, leaves the operative field clear, and blocks outward motion in every direction", () => {
    const geometry = createAbdominalCavityGeometry();
    const guard = new SceneNavigationGuard(() => [{ id: "abdominal-wall", visible: true, geometry }]);
    const scope = new THREE.Vector3(-4, -32, 247), target = new THREE.Vector3(-4, 1, 0);
    expect(guard.closest(scope, 35)).toBeNull();
    expect(guard.rayDistance(scope, target.clone().sub(scope).normalize(), 600)).toBeGreaterThan(scope.distanceTo(target) + 80);
    const bounds = geometry.boundingBox!.clone().expandByScalar(500);
    for (const direction of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [1, 1, 1], [-1, 1, -1]]) {
      const axis = new THREE.Vector3(...direction).normalize();
      const result = guard.move(scope, scope.clone().addScaledVector(axis, 800), bounds);
      expect(result.blocked).toBe(true); expect(result.blockedBy).toBe("abdominal-wall");
      expect(result.position.distanceTo(scope)).toBeGreaterThan(35);
      expect(result.position.distanceTo(scope)).toBeLessThan(600);
      expect(guard.closest(result.position, 1.95)).toBeNull();
    }
    geometry.dispose();
  });

  it("replays exactly and rejects unsafe tessellation requests", () => {
    const a = createAbdominalCavityGeometry(64, 40), b = createAbdominalCavityGeometry(64, 40);
    expect(a.getAttribute("position").array).toEqual(b.getAttribute("position").array);
    expect(a.index!.array).toEqual(b.index!.array);
    for (const args of [[NaN, 40], [64.5, 40], [8, 40], [64, 0], [1024, 40]]) expect(() => createAbdominalCavityGeometry(...args as [number, number])).toThrow();
    a.dispose(); b.dispose();
  });
});
