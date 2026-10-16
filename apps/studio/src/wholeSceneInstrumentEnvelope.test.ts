import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { createLaparoscopicInstrument } from "./laparoscopicInstruments";
import { instrumentContactEnvelopes } from "./wholeSceneInstrumentEnvelope";

const workingMeshNames = new Set([
  "five-mm-steel-shaft", "insulated-shaft-sleeve", "sleeve-edge-band", "machined-shaft-mark",
  "proximal-shaft-transition", "distal-clevis-tube", "jaw-actuator-rod", "clevis-side-arm",
  "hinge-rivet", "hinge-rivet-slot", "fenestrated-atraumatic-jaw", "fine-grip-serration", "probe-distal-neck",
]);
type Envelope = ReturnType<typeof instrumentContactEnvelopes>[number];
const vector = (p: readonly number[]) => new THREE.Vector3(p[0], p[1], p[2]);
function clearance(point: THREE.Vector3, envelope: Envelope) {
  const line = new THREE.Line3(vector(envelope.startMm), vector(envelope.endMm));
  return point.distanceTo(line.closestPointToPoint(point, true, new THREE.Vector3())) - envelope.radiusMm;
}

function assertWorkingTriangleContainment(mode: "push" | "grasp", radius: number, closure: number) {
  const model = createLaparoscopicInstrument(mode === "push" ? "probe" : "grasper");
  try {
    model.setContactRadius(radius); model.setJawClosure(closure); model.group.updateMatrixWorld(true);
    const envelopes = instrumentContactEnvelopes(mode, radius, closure);
    const witnesses: { mesh: string; triangle: number; outsideMm: number }[] = [];
    const testedNames = new Set<string>();
    let triangles = 0;
    model.group.traverse(object => {
      if (!(object instanceof THREE.Mesh) || !workingMeshNames.has(object.name)) return;
      testedNames.add(object.name);
      const position = object.geometry.getAttribute("position");
      const points = Array.from({ length: position.count }, (_, i) => new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(object.matrixWorld));
      const index = object.geometry.index;
      const count = index ? index.count : position.count;
      for (let i = 0; i < count; i += 3) {
        const face = [0, 1, 2].map(k => points[index ? index.getX(i + k) : i + k]!);
        // All three vertices must be in ONE convex capsule. This proves the
        // complete planar triangle is contained, unlike testing a vertex union.
        const outsideMm = Math.min(...envelopes.map(envelope => Math.max(...face.map(point => clearance(point, envelope)))));
        if (outsideMm > 1e-5) witnesses.push({ mesh: object.name, triangle: i / 3, outsideMm });
        triangles++;
      }
    });
    expect(triangles).toBeGreaterThan(1000);
    expect(testedNames.has("sleeve-edge-band")).toBe(true);
    expect(testedNames.has("proximal-shaft-transition")).toBe(true);
    expect(testedNames.has(mode === "push" ? "probe-distal-neck" : "fenestrated-atraumatic-jaw")).toBe(true);
    if (mode === "grasp") expect(testedNames.has("clevis-side-arm")).toBe(true);
    expect(witnesses.slice(0, 10), `${witnesses.length} working triangles escape every single capsule`).toEqual([]);
  } finally { model.dispose(); }
}

describe("actual instrument geometry inside contact envelopes", () => {
  for (const closure of [0, .25, .5, .75, 1]) {
    it(`contains every grasper working triangle at closure ${closure}`, () => {
      assertWorkingTriangleContainment("grasp", 6, closure);
    });
  }
  for (const radius of [3, 6, 10]) {
    it(`contains every probe working triangle at radius ${radius} mm`, () => {
      assertWorkingTriangleContainment("push", radius, 1);
    });
  }
  it("leaves the empty lateral opening near the open hinge clear", () => {
    const emptyPoint = new THREE.Vector3(8, 0, 17);
    const actual = instrumentContactEnvelopes("grasp", 6, 0);
    expect(Math.min(...actual.map(envelope => clearance(emptyPoint, envelope)))).toBeGreaterThan(2);
    // It is also clear of the separate distal 3 mm grasp contact sphere.
    expect(emptyPoint.distanceTo(new THREE.Vector3(0, 0, 3))).toBeGreaterThan(3);
    // Historical uniform open-jaw capsule would block this empty region.
    const oldAxis = new THREE.Line3(new THREE.Vector3(), new THREE.Vector3(0, 0, 19));
    const oldDistance = emptyPoint.distanceTo(oldAxis.closestPointToPoint(emptyPoint, true, new THREE.Vector3()));
    expect(oldDistance - 11.2).toBeLessThan(-3);
  });
});
