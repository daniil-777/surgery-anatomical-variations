import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { createCuttingScalpel } from "./scalpel";
import { scalpelContact } from "./solver";
import { DEFAULT_SCALPEL, type ScalpelGeometry } from "./types";

function inspectSurface(shape: ScalpelGeometry) {
  const instrument = createCuttingScalpel(shape);
  const blade = instrument.group.getObjectByName("mechanical-wedge") as THREE.Mesh<THREE.BufferGeometry, THREE.Material[]>;
  const positions = blade.geometry.getAttribute("position"), edges = new Map<string, number>(), normals = blade.geometry.getAttribute("normal");
  let volume = 0;
  const key = (point: THREE.Vector3) => point.toArray().map(value => value.toFixed(6)).join(",");
  for (let i = 0; i < positions.count; i += 3) {
    const triangle = [0, 1, 2].map(offset => new THREE.Vector3().fromBufferAttribute(positions, i + offset));
    const normal = new THREE.Vector3().fromBufferAttribute(normals, i);
    const cross = triangle[1]!.clone().sub(triangle[0]!).cross(triangle[2]!.clone().sub(triangle[0]!));
    expect(cross.length()).toBeGreaterThan(1e-7);
    expect(cross.normalize().dot(normal)).toBeGreaterThan(.999999);
    volume += triangle[0]!.dot(triangle[1]!.clone().cross(triangle[2]!)) / 6;
    for (let j = 0; j < 3; j++) {
      const edge = [key(triangle[j]!), key(triangle[(j + 1) % 3]!)].sort().join("|");
      edges.set(edge, (edges.get(edge) ?? 0) + 1);
    }
  }
  expect([...edges.values()].every(count => count === 2)).toBe(true);
  const { halfThicknessMm: h, halfLengthMm: length, heightMm: height, halfAngleRadians: angle } = shape;
  const end = shape.endBevelMm ?? 0, slope = Math.tan(angle);
  const expectedVolume = 4 * height * length * h - 2 * height * end * h - 2 * length * h * h / slope + 4 / 3 * end * h * h / slope;
  expect(volume).toBeCloseTo(expectedVolume, 4);
  return { instrument, blade, positions, normals };
}

describe("finite scalpel geometry", () => {
  it("uses the exact mechanical wedge dimensions, edge and bevel", () => {
    const { instrument, blade, positions: vertices, normals } = inspectSurface(DEFAULT_SCALPEL);
    blade.geometry.computeBoundingBox(); const bounds = blade.geometry.boundingBox!;
    expect(bounds.min.x).toBeCloseTo(-DEFAULT_SCALPEL.halfThicknessMm, 6); expect(bounds.max.x).toBeCloseTo(DEFAULT_SCALPEL.halfThicknessMm, 6);
    expect(bounds.min.y).toBe(0); expect(bounds.max.y).toBe(DEFAULT_SCALPEL.heightMm);
    expect(bounds.min.z).toBe(-DEFAULT_SCALPEL.halfLengthMm); expect(bounds.max.z).toBe(DEFAULT_SCALPEL.halfLengthMm);
    expect(vertices.count / 3).toBe(20);
    const endSlope = DEFAULT_SCALPEL.halfThicknessMm / DEFAULT_SCALPEL.endBevelMm!;
    let endTriangles = 0, lowerTriangles = 0;
    for (let i = 0; i < vertices.count; i++) {
      expect(Math.abs(vertices.getX(i))).toBeLessThanOrEqual(Math.min(DEFAULT_SCALPEL.halfThicknessMm, vertices.getY(i) * Math.tan(DEFAULT_SCALPEL.halfAngleRadians), endSlope * (DEFAULT_SCALPEL.halfLengthMm - Math.abs(vertices.getZ(i)))) + 1e-6);
      if (i % 3) continue;
      const normal = new THREE.Vector3().fromBufferAttribute(normals, i);
      if (Math.abs(normal.z) > .1) {
        endTriangles++;
        expect(Math.abs(normal.x)).toBeCloseTo(1 / Math.hypot(1, endSlope), 6);
        expect(Math.abs(normal.z)).toBeCloseTo(endSlope / Math.hypot(1, endSlope), 6);
        const centerZ = (vertices.getZ(i) + vertices.getZ(i + 1) + vertices.getZ(i + 2)) / 3;
        expect(Math.sign(normal.z)).toBe(Math.sign(centerZ));
      }
      if (normal.y < -.1) lowerTriangles++;
    }
    expect(endTriangles).toBe(8); expect(lowerTriangles).toBe(4);
    expect(blade.geometry.groups.filter(group => group.materialIndex === 1).reduce((sum, group) => sum + group.count / 3, 0)).toBe(12);
    expect(blade.material.every(material => !material.polygonOffset)).toBe(true);
    instrument.setPose({ active: true, tipYMm: 12, centerZMm: -4 }, 8); expect(instrument.group.position.toArray()).toEqual([8, 12, -4]); instrument.dispose(); instrument.dispose();
  });
  it("keeps omitted and zero end bevels compatible with the original blunt finite wedge", () => {
    const { endBevelMm: _end, ...legacy } = DEFAULT_SCALPEL;
    const a = inspectSurface(legacy), b = inspectSurface({ ...legacy, endBevelMm: 0 });
    expect(a.positions.array).toEqual(b.positions.array);
    expect(a.instrument.group.userData.contactDimensions.endBevelMm).toBe(0);
    expect(a.blade.geometry.groups.filter(group => group.materialIndex === 1).reduce((sum, group) => sum + group.count / 3, 0)).toBe(4);
    a.instrument.dispose(); b.instrument.dispose();
  });
  it("matches the mechanical collider at every rendered face, including sharpened and legacy ends", () => {
    for (const shape of [DEFAULT_SCALPEL, { ...DEFAULT_SCALPEL, endBevelMm: 0 }]) {
      const { instrument, positions, normals } = inspectSurface(shape);
      const pose = { active: true, tipYMm: 0, centerZMm: 0 }, epsilonMm = .0002;
      for (let i = 0; i < positions.count; i += 3) {
        const center = new THREE.Vector3();
        for (let j = 0; j < 3; j++) center.add(new THREE.Vector3().fromBufferAttribute(positions, i + j));
        center.multiplyScalar(1 / 3);
        const normal = new THREE.Vector3().fromBufferAttribute(normals, i).normalize();
        const inside = center.clone().addScaledVector(normal, -epsilonMm).multiplyScalar(.001);
        const outside = center.clone().addScaledVector(normal, epsilonMm).multiplyScalar(.001);
        const side = center.x < 0 ? -1 : 1;
        const response = scalpelContact(inside.toArray(), 0, pose, shape, side);
        expect(response.penetrationM).toBeCloseTo(epsilonMm * .001, 9);
        expect(new THREE.Vector3(...response.normal).dot(normal)).toBeGreaterThan(.999999);
        expect(scalpelContact(outside.toArray(), 0, pose, shape, side).penetrationM).toBe(0);
      }
      instrument.dispose();
    }
  });
  it("rejects invalid geometry and nonfinite poses before scene mutation", () => {
    expect(() => createCuttingScalpel({ ...DEFAULT_SCALPEL, halfAngleRadians: 0 })).toThrow();
    for (const endBevelMm of [-1, NaN, Infinity, DEFAULT_SCALPEL.halfLengthMm]) expect(() => createCuttingScalpel({ ...DEFAULT_SCALPEL, endBevelMm })).toThrow();
    const instrument = createCuttingScalpel(); expect(() => instrument.setPose({ active: true, tipYMm: NaN, centerZMm: 0 }, 0)).toThrow(); expect(instrument.group.position.toArray()).toEqual([0, 0, 0]); instrument.dispose();
  });
  it("can hide the cosmetic handle without hiding or moving the contact blade", () => {
    const instrument = createCuttingScalpel();
    instrument.setPose({ active: true, tipYMm: 12, centerZMm: -4 }, 8);
    const blade = instrument.group.getObjectByName("mechanical-wedge") as THREE.Mesh;
    const before = blade.geometry.getAttribute("position").array.slice();
    instrument.setHandleVisible(false);
    expect(blade.visible).toBe(true);
    expect(instrument.group.children.filter(child => child !== blade).every(child => !child.visible)).toBe(true);
    expect(instrument.group.position.toArray()).toEqual([8, 12, -4]);
    expect(blade.geometry.getAttribute("position").array).toEqual(before);
    instrument.setHandleVisible(true);
    expect(instrument.group.children.every(child => child.visible)).toBe(true);
    instrument.dispose();
  });
});
