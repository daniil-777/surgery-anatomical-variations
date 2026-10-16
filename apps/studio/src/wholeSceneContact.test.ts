import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { SceneSurfaceContact, barycentricSurfacePoint } from "./wholeSceneContact";

const rest = new Float32Array([-50, -50, 0, 50, -50, 0, 0, 50, 0]);
const indices = new Uint32Array([0, 1, 2]);
const surface = () => new SceneSurfaceContact("test-sheet", rest, indices);

describe("accelerated current-surface picking", () => {
  it("preserves nearest-hit distance, side selection and deformed/rest attachments", () => {
    const mesh = surface(), moved = rest.slice();
    for (let i = 2; i < moved.length; i += 3) moved[i]! += 7;
    mesh.refit(moved);
    const hit = mesh.raycast([0, 0, 20], [0, 0, -2], "front")!;
    expect(hit.distanceMm).toBeCloseTo(13, 9);
    expect(hit.pointMm).toEqual([0, 0, 7]);
    expect(hit.restPointMm).toEqual([0, 0, 0]);
    expect(hit.normal).toEqual([0, 0, 1]);
    expect(mesh.raycast([0, 0, 20], [0, 0, -1], "front", 12)).toBeNull();
    expect(mesh.raycast([0, 0, -20], [0, 0, 1], "front")).toBeNull();
    expect(mesh.raycast([0, 0, -20], [0, 0, 1], "back")!.normal).toEqual([-0, -0, -1]);
    expect(mesh.raycast([0, 0, 20], [0, 0, 1])).toBeNull();
    expect(mesh.raycast([60, 0, 20], [0, 0, -1])).toBeNull();
    expect(() => mesh.raycast([0, 0, 0], [0, 0, 0])).toThrow();
  });
  for (const side of ["front", "back", "double"] as const) it(`matches independent Three.js picking on deformed ${side}-sided triangles`, () => {
    const geometry = new THREE.SphereGeometry(20, 24, 16);
    const positions = geometry.getAttribute("position");
    const original = new Float32Array(positions.array);
    const contact = new SceneSurfaceContact("sphere", original, new Uint32Array(geometry.index!.array));
    const material = new THREE.MeshBasicMaterial({ side: side === "front" ? THREE.FrontSide : side === "back" ? THREE.BackSide : THREE.DoubleSide });
    const mesh = new THREE.Mesh(geometry, material); mesh.updateMatrixWorld();
    try {
      for (let i = 0; i < positions.count; i++) positions.setXYZ(i, positions.getX(i) * 1.2, positions.getY(i) + 2, positions.getZ(i) * .8);
      geometry.computeBoundingSphere(); contact.refit(positions.array as Float32Array);
      for (let i = 0; i < 80; i++) {
        const origin = new THREE.Vector3(Math.sin(i * 1.7), Math.cos(i * .81), Math.sin(i * .63)).normalize().multiplyScalar(i % 4 ? 60 : 2);
        const target = new THREE.Vector3(Math.sin(i * .31) * 30, 2, Math.cos(i * .51) * 25);
        const direction = target.sub(origin).normalize();
        const expected = new THREE.Raycaster(origin, direction).intersectObject(mesh)[0];
        const actual = contact.raycast(origin.toArray(), direction.toArray(), side);
        expect(Boolean(actual)).toBe(Boolean(expected));
        if (!actual || !expected) continue;
        expect(actual.distanceMm).toBeCloseTo(expected.distance, 7);
        expect(new THREE.Vector3(...actual.pointMm).distanceTo(expected.point)).toBeLessThan(1e-6);
        expect(actual.triangleIndex).toBe(expected.faceIndex);
        expect(actual.barycentric.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 9);
      }
    } finally { geometry.dispose(); material.dispose(); }
  });
  it("prunes distant triangles and selects the nearest sheet rather than BVH order", () => {
    const vertices: number[] = [], faces: number[] = [];
    for (let i = 0; i < 400; i++) { const x = i * 100; vertices.push(x, 0, 0, x + 10, 0, 0, x, 10, 0); faces.push(i * 3, i * 3 + 1, i * 3 + 2); }
    const mesh = new SceneSurfaceContact("many", new Float32Array(vertices), new Uint32Array(faces));
    expect(mesh.raycast([3, 3, 100], [0, 0, -1])!.triangleIndex).toBe(0);
    expect(mesh.snapshot().testedTriangles).toBeLessThan(30);
    expect(mesh.raycast([9, 9, 100], [0, 0, -1])).toBeNull();
    const layered = new SceneSurfaceContact("layers", new Float32Array([...rest, ...Array.from(rest, (v, i) => v + (i % 3 === 2 ? 7 : 0))]), new Uint32Array([0, 1, 2, 3, 4, 5]));
    expect(layered.raycast([0, 0, 10], [0, 0, -1])!.triangleIndex).toBe(1);
  });
});

describe("whole-scene actual triangle contact", () => {
  it("finds triangle face, edge and vertex features with reconstructing barycentrics", () => {
    const mesh = surface();
    for (const [point, expected] of [[[0, 0, 8], [0, 0, 0]], [[0, -55, 0], [0, -50, 0]], [[-55, -55, 0], [-50, -50, 0]]]) {
      const hit = mesh.closestPoint(point!)!;
      hit.pointMm.forEach((v, a) => expect(v).toBeCloseTo(expected![a]!, 10));
      expect(hit.barycentric.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
      expect(barycentricSurfacePoint(rest, hit.vertexIndices, hit.barycentric)).toEqual(hit.restPointMm);
    }
    expect(mesh.closestPoint([0, 0, 10], 5)).toBeNull();
  });
  it("detects an extremely fast sphere sweep through a zero-thickness face from either side", () => {
    const mesh = surface();
    for (const sign of [-1, 1]) {
      const hit = mesh.sweepSphere([0, 0, sign * 1000], [0, 0, -sign * 1000], .5)!;
      expect(hit.time).toBeCloseTo(.49975, 10); expect(hit.distanceMm).toBeCloseTo(.5, 8);
      expect(hit.penetrationMm).toBeLessThan(1e-7); expect(hit.normal[2]).toBe(sign);
    }
  });
  it("catches edge, vertex and exact tangential grazing without inflating the mesh", () => {
    const mesh = surface();
    expect(mesh.sweepSphere([0, -60, 0], [0, -40, 0], 2)!.time).toBeCloseTo(.4, 10);
    expect(mesh.sweepSphere([-60, -60, 0], [-40, -40, 0], 2)!.time).toBeCloseTo((Math.sqrt(200) - 2) / Math.sqrt(800), 10);
    expect(mesh.sweepSphere([-80, -52, 0], [80, -52, 0], 2)!.time).toBeCloseTo(30 / 160, 8);
    expect(mesh.sweepSphere([-80, -52.01, 0], [80, -52.01, 0], 2)).toBeNull();
  });
  it("reports initial overlap and remains well defined on degenerate source triangles", () => {
    const mesh = surface(), initial = mesh.sweepSphere([0, 0, 1], [0, 0, -9], 2)!;
    expect(initial.time).toBe(0); expect(initial.penetrationMm).toBeCloseTo(1, 10);
    const line = new SceneSurfaceContact("source-degenerate", new Float32Array([0, 0, 0, 10, 0, 0, 20, 0, 0]), indices);
    expect(line.closestPoint([5, 3, 0])!.distanceMm).toBeCloseTo(3, 10);
    expect(line.sweepSphere([5, 10, 0], [5, -10, 0], 1)!.time).toBeCloseTo(.45, 10);
  });
  it("permits separating and tangential motion from initial touching contact", () => {
    const mesh = surface();
    expect(mesh.sweepSphere([0, 0, 2], [0, 0, 10], 2)).toBeNull();
    expect(mesh.sweepSphere([0, 0, 2], [10, 0, 2], 2)).toBeNull();
    expect(mesh.sweepSphere([0, 0, 1], [0, 0, 10], 2)).toBeNull();
    expect(mesh.sweepSphere([0, 0, 1], [10, 0, 1], 2)!.time).toBe(0);
    expect(mesh.sweepSphere([0, 0, 2], [0, 0, -10], 2)!.time).toBe(0);
    expect(mesh.sweepCapsule([-20, 0, 2], [20, 0, 2], [-20, 0, 8], [20, 0, 8], 2)).toBeNull();
    expect(mesh.sweepCapsule([-20, 0, 2], [20, 0, 2], [-20, 0, -8], [20, 0, -8], 2)!.time).toBe(0);
  });
  it("distinguishes exact grazing from a near miss even over a million-millimetre path", () => {
    const mesh = surface();
    expect(mesh.sweepSphere([-1e6, -52, 0], [1e6, -52, 0], 2)).not.toBeNull();
    expect(mesh.sweepSphere([-1e6, -52.001, 0], [1e6, -52.001, 0], 2)).toBeNull();
  });
  it("refits to moving triangle positions while preserving original rest attachments", () => {
    const mesh = surface(), moved = rest.slice(); for (let i = 2; i < moved.length; i += 3) moved[i]! += 7;
    mesh.refit(moved); const hit = mesh.sweepSphere([0, 0, 20], [0, 0, 0], 2)!;
    expect(hit.time).toBeCloseTo(.55, 10); expect(hit.pointMm[2]).toBeCloseTo(7, 10); expect(hit.restPointMm[2]).toBe(0);
    expect(mesh.snapshot().refits).toBe(1);
  });
  it("tests the whole shaft capsule, including interior segment-face crossing", () => {
    const mesh = surface();
    const crossing = mesh.closestCapsule([0, 0, -10], [0, 0, 10], 1)!;
    expect(crossing.distanceMm).toBeCloseTo(0, 10); expect(crossing.penetrationMm).toBeCloseTo(1, 10);
    expect(mesh.closestCapsule([-20, 0, 5], [20, 0, 5], 2)).toBeNull();
    const hit = mesh.sweepCapsule([-20, 0, 20], [20, 0, 20], [-20, 0, -20], [20, 0, -20], 2)!;
    expect(hit.time).toBeCloseTo(.45, 5); expect(hit.penetrationMm).toBeLessThan(1e-5); expect(hit.conservativeStop).toBe(false);
  });
  it("guards rotating as well as translating shafts over a thin surface", () => {
    const hit = surface().sweepCapsule([-20, 0, 10], [20, 0, 10], [-20, 0, 10], [20, 0, -10], 2)!;
    expect(hit.time).toBeCloseTo(.4, 5); expect(hit.clearanceMm).toBeLessThanOrEqual(1e-5);
    const changingFeature = surface().sweepCapsule([-20, 0, 2], [20, 0, 20], [-20, 0, 20], [20, 0, -20], 2)!;
    expect(changingFeature.time).toBeGreaterThan(0); expect(changingFeature.time).toBeLessThanOrEqual(.45);
    expect(changingFeature.conservativeStop).toBe(true);
  });
  it("uses BVH leaves rather than bounding boxes as collision surfaces", () => {
    const vertices: number[] = [], faces: number[] = [];
    for (let i = 0; i < 400; i++) { const x = i * 100; vertices.push(x, 0, 0, x + 10, 0, 0, x, 10, 0); faces.push(i * 3, i * 3 + 1, i * 3 + 2); }
    const mesh = new SceneSurfaceContact("many", new Float32Array(vertices), new Uint32Array(faces));
    expect(mesh.sweepSphere([3, 3, 100], [3, 3, -100], 1)).not.toBeNull();
    expect(mesh.snapshot().testedTriangles).toBeLessThan(30);
    expect(mesh.sweepSphere([9, 9, 100], [9, 9, -100], 1)).toBeNull();
  });
  it("excludes only a connected local grip patch, preserving adjacent-loop collisions", () => {
    const vertices = new Float32Array([...rest, ...Array.from(rest, (v, i) => v + (i % 3 === 2 ? 2 : 0))]);
    const mesh = new SceneSurfaceContact("two-bowel-loops", vertices, new Uint32Array([0, 1, 2, 3, 4, 5]));
    const patch = mesh.contactPatch(0, [0, 0, 0], 12);
    expect([...patch]).toEqual([0]);
    expect(mesh.closestPoint([0, 0, .2], Infinity, patch)!.triangleIndex).toBe(1);
    const sphere = mesh.sweepSphere([0, 0, 10], [0, 0, -10], 1, patch)!;
    expect(sphere.triangleIndex).toBe(1); expect(sphere.time).toBeCloseTo(.35, 10);
    expect(mesh.closestCapsule([-10, 0, 2], [10, 0, 2], 1, patch)!.triangleIndex).toBe(1);
    const sweep = mesh.sweepCapsule([-10, 0, 10], [10, 0, 10], [-10, 0, -10], [10, 0, -10], 1, patch)!;
    expect(sweep.triangleIndex).toBe(1); expect(sweep.time).toBeCloseTo(.35, 5);
  });
  it("reports the deepest static capsule overlap rather than the first touching triangle", () => {
    const vertices = new Float32Array([...rest, ...Array.from(rest, (v, i) => v + (i % 3 === 2 ? 1.9 : 0))]);
    const mesh = new SceneSurfaceContact("layered-sheet", vertices, new Uint32Array([0, 1, 2, 3, 4, 5]));
    const hit = mesh.closestCapsule([-20, 0, 2], [20, 0, 2], 2)!;
    expect(hit.triangleIndex).toBe(1); expect(hit.penetrationMm).toBeCloseTo(1.9, 6);
  });
  it("rejects invalid source data and non-finite queries", () => {
    expect(() => new SceneSurfaceContact("bad", rest, new Uint32Array([0, 1, 10]))).toThrow();
    expect(() => surface().refit(new Float32Array([NaN, 0, 0]))).toThrow();
    expect(() => surface().sweepSphere([NaN, 0, 0], [0, 0, 0], 1)).toThrow();
    expect(() => surface().sweepCapsule([0, 0, 0], [0, 0, 1], [0, 0, 0], [0, 0, 1], -1)).toThrow();
  });
});
