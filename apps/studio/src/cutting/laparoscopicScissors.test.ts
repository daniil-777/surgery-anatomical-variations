import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { createLaparoscopicScissors, LAPAROSCOPIC_SCISSORS_CUTTING_EDGE as edge, LAPAROSCOPIC_SCISSORS_DIMENSIONS as dimensions } from "./laparoscopicScissors";

const mesh = (group: THREE.Group, name: string) => group.getObjectByName(name) as THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>;
const closeVector = (a: THREE.Vector3, b: THREE.Vector3) => expect(a.distanceTo(b)).toBeLessThan(1e-10);

describe("finite articulated laparoscopic scissors", () => {
  it("builds two closed metal blades with integrated bevels and the declared radial working length", () => {
    const instrument = createLaparoscopicScissors();
    const jaws = ["upper-scissors-jaw", "lower-scissors-jaw"].map(name => instrument.group.getObjectByName(name)!);
    const blades = jaws.map(jaw => jaw.getObjectByName("finite-scissors-blade") as THREE.Mesh<THREE.BufferGeometry, THREE.Material[]>);
    expect(blades).toHaveLength(2); expect(blades[0]!.geometry).toBe(blades[1]!.geometry);
    const blade = blades[0]!, positions = blade.geometry.getAttribute("position"), normals = blade.geometry.getAttribute("normal");
    const edges = new Map<string, number>(); let volume = 0;
    const key = (p: THREE.Vector3) => p.toArray().map(value => value.toFixed(6)).join(",");
    for (let i = 0; i < positions.count; i += 3) {
      const triangle = [0, 1, 2].map(j => new THREE.Vector3().fromBufferAttribute(positions, i + j));
      const cross = triangle[1]!.clone().sub(triangle[0]!).cross(triangle[2]!.clone().sub(triangle[0]!));
      expect(cross.length()).toBeGreaterThan(1e-6);
      expect(cross.normalize().dot(new THREE.Vector3().fromBufferAttribute(normals, i))).toBeGreaterThan(.999999);
      volume += triangle[0]!.dot(triangle[1]!.clone().cross(triangle[2]!)) / 6;
      for (let j = 0; j < 3; j++) { const pair = [key(triangle[j]!), key(triangle[(j + 1) % 3]!)].sort().join("|"); edges.set(pair, (edges.get(pair) ?? 0) + 1); }
    }
    expect([...edges.values()].every(count => count === 2)).toBe(true); expect(volume).toBeGreaterThan(10);
    const bounds = blade.geometry.boundingBox!;
    expect(bounds.min.z).toBe(0); expect(bounds.max.z).toBe(dimensions.jawLengthMm);
    expect(bounds.min.x).toBeCloseTo(-dimensions.bladeThicknessMm / 2, 6); expect(bounds.max.x).toBeCloseTo(dimensions.bladeThicknessMm / 2, 6);
    expect(bounds.min.y).toBe(0); expect(bounds.max.y).toBeLessThan(2.2);
    expect(blade.geometry.groups).toHaveLength(2);
    expect(blade.geometry.groups[1]!.count).toBeGreaterThan(0); expect(blade.material[1]!.name).toBe("scissors-polished-cutting-edge");
    expect(blade.material.every(material => !material.polygonOffset)).toBe(true);
    expect(edge.startMm).toEqual([0, 0, 2.5]); expect(edge.endMm).toEqual([0, 0, 18]);
    instrument.dispose();
  });

  it("opens about X with exact finite radial edges rather than extending tips to a rectangular cut region", () => {
    const instrument = createLaparoscopicScissors();
    for (const opening of [0, .25, .5, .75, 1]) {
      instrument.setOpening(opening); instrument.group.updateMatrixWorld(true);
      const angle = opening * dimensions.maximumOpeningRadians / 2;
      for (const side of [-1, 1]) {
        const jaw = instrument.group.getObjectByName(side > 0 ? "upper-scissors-jaw" : "lower-scissors-jaw")!;
        for (const length of [dimensions.activeStartMm, dimensions.jawLengthMm]) {
          const actual = jaw.localToWorld(new THREE.Vector3(-side * dimensions.bladeThicknessMm / 2, 0, length));
          closeVector(actual, new THREE.Vector3(side * .04, side * length * Math.sin(angle), length * Math.cos(angle)));
          expect(Math.hypot(actual.y, actual.z)).toBeCloseTo(length, 12);
        }
      }
      expect(instrument.group.userData.openingRadians).toBeCloseTo(2 * angle, 14);
    }
    instrument.setOpening(2); expect(instrument.group.userData.openingFraction).toBe(1);
    instrument.setOpening(-1); expect(instrument.group.userData.openingFraction).toBe(0);
    instrument.dispose();
  });

  it("applies a normalized arbitrary 3D pose to both the jaws and shaft without changing their geometry", () => {
    const instrument = createLaparoscopicScissors(), blade = mesh(instrument.group, "finite-scissors-blade");
    const before = blade.geometry.getAttribute("position").array.slice();
    const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(2, 1, -3).normalize(), .73), position = new THREE.Vector3(7, -19, 32);
    instrument.setOpening(.5); instrument.setPose(position.toArray(), rotation.toArray().map(value => value * 7) as [number, number, number, number]);
    instrument.group.updateMatrixWorld(true);
    expect(instrument.group.quaternion.length()).toBeCloseTo(1, 14);
    const jaw = instrument.group.getObjectByName("upper-scissors-jaw")!, angle = dimensions.maximumOpeningRadians / 4;
    const expected = new THREE.Vector3(.04, 18 * Math.sin(angle), 18 * Math.cos(angle)).applyQuaternion(rotation).add(position);
    closeVector(jaw.localToWorld(new THREE.Vector3(-.3, 0, 18)), expected);
    closeVector(instrument.group.localToWorld(new THREE.Vector3(0, 0, -40)), new THREE.Vector3(0, 0, -40).applyQuaternion(rotation).add(position));
    expect(blade.geometry.getAttribute("position").array).toEqual(before);
    instrument.dispose();
  });

  it("hides only the proximal handle and retains visible articulated working geometry", () => {
    const instrument = createLaparoscopicScissors(); instrument.setPose([1, 2, 3], [0, 0, 0, 1]); instrument.setOpening(.4);
    const handle = instrument.group.getObjectByName("scissors-proximal-handle")!, jaw = instrument.group.getObjectByName("upper-scissors-jaw")!;
    const before = jaw.rotation.x; instrument.setHandleVisible(false);
    expect(handle.visible).toBe(false);
    for (const child of instrument.group.children.filter(child => child !== handle)) expect(child.visible).toBe(true);
    expect(instrument.group.getObjectByName("scissors-shaft-and-pivot")!.visible).toBe(true);
    expect(jaw.rotation.x).toBe(before); expect(instrument.group.position.toArray()).toEqual([1, 2, 3]);
    instrument.setOpening(.9); expect(jaw.rotation.x).not.toBe(before);
    instrument.setHandleVisible(true); expect(handle.visible).toBe(true); instrument.dispose();
  });

  it("rejects invalid input atomically and disposes shared resources once without affecting another instance", () => {
    const instrument = createLaparoscopicScissors(), independent = createLaparoscopicScissors(), parent = new THREE.Group(); parent.add(instrument.group);
    instrument.setPose([2, 3, 4], [0, 0, 0, 1]); instrument.setOpening(.6);
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(() => instrument.setPose([bad, 0, 0], [0, 0, 0, 1])).toThrow();
      expect(() => instrument.setPose([0, 0, 0], [bad, 0, 0, 1])).toThrow();
      expect(() => instrument.setOpening(bad)).toThrow();
    }
    expect(() => instrument.setPose([0, 0, 0], [0, 0, 0, 0])).toThrow();
    expect(instrument.group.position.toArray()).toEqual([2, 3, 4]); expect(instrument.group.quaternion.toArray()).toEqual([0, 0, 0, 1]); expect(instrument.group.userData.openingFraction).toBe(.6);
    const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>();
    instrument.group.traverse(object => { if (object instanceof THREE.Mesh) { geometries.add(object.geometry); for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material); } });
    let geometryDisposals = 0, materialDisposals = 0, independentDisposals = 0;
    for (const geometry of geometries) geometry.addEventListener("dispose", () => geometryDisposals++);
    for (const material of materials) material.addEventListener("dispose", () => materialDisposals++);
    mesh(independent.group, "finite-scissors-blade").geometry.addEventListener("dispose", () => independentDisposals++);
    instrument.dispose(); instrument.dispose();
    expect(geometryDisposals).toBe(geometries.size); expect(materialDisposals).toBe(materials.size); expect(independentDisposals).toBe(0);
    expect(instrument.group.parent).toBe(null); expect(instrument.group.children).toHaveLength(0);
    expect(() => instrument.setOpening(0)).toThrow(/disposed/); expect(() => instrument.setPose([0, 0, 0], [0, 0, 0, 1])).toThrow(/disposed/);
    independent.setOpening(.3); independent.dispose(); expect(independentDisposals).toBe(1);
  });
});
