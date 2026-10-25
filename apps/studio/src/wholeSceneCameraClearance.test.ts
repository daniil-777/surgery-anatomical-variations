import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { createLaparoscopicInstrument } from "./laparoscopicInstruments";
import { cameraInstrumentClearance, cameraInstrumentEnvelopes, CAMERA_GUARD_RADIUS_MM, type CameraInstrumentEnvelope } from "./wholeSceneCameraClearance";
const zero = new THREE.Vector3(), axis = new THREE.Vector3(0, 0, 1);
function localClearance(point: THREE.Vector3, envelope: CameraInstrumentEnvelope) {
  if (envelope.shape === "box") {
    return Math.max(...[0, 1, 2].map(a => Math.max(envelope.minimumMm[a]! - point.getComponent(a), point.getComponent(a) - envelope.maximumMm[a]!)));
  }
  const line = new THREE.Line3(new THREE.Vector3(...envelope.startMm), new THREE.Vector3(...envelope.endMm));
  return point.distanceTo(line.closestPointToPoint(point, true, new THREE.Vector3())) - envelope.radiusMm;
}
function assertVisibleTriangleContainment(mode: "push" | "grasp", radius: number, closure: number) {
  const instrument = createLaparoscopicInstrument(mode === "push" ? "probe" : "grasper");
  try {
    instrument.setContactRadius(radius); instrument.setJawClosure(closure); instrument.group.updateMatrixWorld(true);
    const envelopes = cameraInstrumentEnvelopes(mode, radius, closure), witnesses: { mesh: string; triangle: number; gap: number }[] = [];
    let triangles = 0, handleTriangles = 0;
    instrument.group.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      const position = object.geometry.getAttribute("position"), index = object.geometry.index;
      const points = Array.from({ length: position.count }, (_, i) => new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(object.matrixWorld));
      const count = index?.count ?? position.count;
      for (let i = 0; i < count; i += 3) {
        const vertices = [0, 1, 2].map(k => points[index ? index.getX(i + k) : i + k]!);
        // One convex envelope must contain all vertices, proving containment
        // of the whole visible triangle rather than only a union of vertices.
        const gaps = envelopes.map(envelope => Math.max(...vertices.map(point => localClearance(point, envelope))));
        const gap = Math.min(...gaps); if (gap > 1e-5) witnesses.push({ mesh: object.name, triangle: i / 3, gap });
        if (envelopes.some((envelope, j) => envelope.kind === "handle" && gaps[j]! <= 1e-5)) handleTriangles++;
        triangles++;
      }
    });
    expect(triangles).toBeGreaterThan(5000); expect(handleTriangles).toBeGreaterThan(1000);
    expect(witnesses.slice(0, 8), `${witnesses.length} visible triangles escape camera envelopes`).toEqual([]);
  } finally { instrument.dispose(); }
}

describe("camera lens versus full laparoscopic instrument", () => {
  it("blocks the recorded blue-handle camera intersection", () => {
    const camera = new THREE.Vector3(-109.3586, -16.811, 225.1229), origin = new THREE.Vector3(67.12, -89.7566, 57.3324), direction = new THREE.Vector3(-.697254, .287798, .656512);
    for (const mode of ["push", "grasp"] as const) {
      const result = cameraInstrumentClearance(camera, origin, origin, direction, mode, 6, .7);
      expect(result.clearanceMm).toBeLessThan(0); expect(result.kind).toBe("handle");
    }
  });
  it("catches a handle crossing the lens during a translated sweep with safe endpoints", () => {
    const camera = new THREE.Vector3(0, 0, 273), from = new THREE.Vector3(-25, 0, 0), to = new THREE.Vector3(25, 0, 0);
    expect(cameraInstrumentClearance(camera, from, from, axis, "push", 6, 1).clearanceMm).toBeGreaterThan(10);
    expect(cameraInstrumentClearance(camera, to, to, axis, "push", 6, 1).clearanceMm).toBeGreaterThan(10);
    expect(cameraInstrumentClearance(camera, from, to, axis, "push", 6, 1)).toEqual({ clearanceMm: -CAMERA_GUARD_RADIUS_MM, kind: "handle" });
  });
  it("checks exact finite shaft and spherical tip clearance, including grazing and withdrawal", () => {
    expect(cameraInstrumentClearance(new THREE.Vector3(10, 0, 120), zero, zero, axis, "push", 6, 1)).toEqual({ clearanceMm: 3.25, kind: "shaft" });
    expect(cameraInstrumentClearance(new THREE.Vector3(6.75, 0, 120), zero, zero, axis, "push", 6, 1).clearanceMm).toBeCloseTo(0, 10);
    expect(cameraInstrumentClearance(new THREE.Vector3(0, 0, -4), zero, zero, axis, "push", 6, 1)).toEqual({ clearanceMm: 0, kind: "tip" });
    const from = new THREE.Vector3(0, 0, -150), to = new THREE.Vector3(0, 0, 150), camera = new THREE.Vector3(0, 0, 100);
    expect(cameraInstrumentClearance(camera, from, to, axis, "push", 6, 1).clearanceMm).toBeLessThan(0);
    expect(cameraInstrumentClearance(new THREE.Vector3(30, 0, 100), from, to, axis, "push", 6, 1).clearanceMm).toBeGreaterThan(15);
  });
  it("preserves clearance under a common rigid transform and sweep reversal", () => {
    const camera = new THREE.Vector3(30, -15, 264), from = new THREE.Vector3(-5, 0, 0), to = new THREE.Vector3(6, 2, 4);
    const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(.2, .5, .3).normalize(), 1.1), offset = new THREE.Vector3(47, -39, 112);
    // The API chooses the renderer's shortest-arc +Z→axis orientation. Use
    // that same rotation, rather than introducing an unrepresented roll.
    const direction = axis.clone().applyQuaternion(rotation), actualRotation = new THREE.Quaternion().setFromUnitVectors(axis, direction);
    const transform = (point: THREE.Vector3) => point.clone().applyQuaternion(actualRotation).add(offset);
    const a = cameraInstrumentClearance(camera, from, to, axis, "grasp", 3, .3);
    const b = cameraInstrumentClearance(transform(camera), transform(from), transform(to), direction, "grasp", 3, .3);
    expect(b.clearanceMm).toBeCloseTo(a.clearanceMm, 10); expect(b.kind).toBe(a.kind);
    const reversed = cameraInstrumentClearance(camera, to, from, axis, "grasp", 3, .3);
    expect(reversed.clearanceMm).toBeCloseTo(a.clearanceMm, 10); expect(reversed.kind).toBe(a.kind);
  });
  it("bounds the actual articulated handle over the complete continuous closure interval", () => {
    const instrument = createLaparoscopicInstrument("grasper");
    try {
      instrument.group.updateMatrixWorld(true);
      const trigger = instrument.group.getObjectByName("articulated-trigger-handle")!, inverse = trigger.matrixWorld.clone().invert(), source = new THREE.Box3();
      trigger.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return;
        const position = object.geometry.getAttribute("position");
        for (let i = 0; i < position.count; i++) source.expandByPoint(new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(object.matrixWorld).applyMatrix4(inverse));
      });
      const triggerBounds = cameraInstrumentEnvelopes("grasp", 3, 0).at(-1)!;
      for (let corner = 0; corner < 8; corner++) {
        const x = corner & 1 ? source.max.x : source.min.x, y = corner & 2 ? source.max.y : source.min.y, z = corner & 4 ? source.max.z : source.min.z;
        const candidates = [-.16, .13];
        // y*cosθ-z*sinθ and y*sinθ+z*cosθ reach their extrema at
        // endpoints or these stationary angles. This covers every closure,
        // including extrema that a finite angle-sampling test could miss.
        for (const critical of [Math.atan2(-z, y), Math.atan2(y, z)]) for (const turn of [-1, 0, 1]) {
          const theta = critical + turn * Math.PI; if (theta > -.16 && theta < .13) candidates.push(theta);
        }
        for (const theta of candidates) {
          const point = new THREE.Vector3(x, y * Math.cos(theta) - z * Math.sin(theta), y * Math.sin(theta) + z * Math.cos(theta) + 259);
          expect(localClearance(point, triggerBounds)).toBeLessThanOrEqual(0);
        }
      }
    } finally { instrument.dispose(); }
  });
  it("rejects invalid poses and radii rather than accepting nonfinite clearance", () => {
    expect(() => cameraInstrumentClearance(new THREE.Vector3(NaN, 0, 0), zero, zero, axis, "push", 6, 1)).toThrow();
    expect(() => cameraInstrumentClearance(zero, zero, zero, zero, "push", 6, 1)).toThrow();
    expect(() => cameraInstrumentClearance(zero, zero, zero, axis, "push", 0, 1)).toThrow();
    expect(() => cameraInstrumentClearance(zero, zero, zero, axis, "grasp", 3, NaN)).toThrow();
  });
  for (const radius of [1, 3, 6, 10, 25, 60]) it(`contains every probe triangle including its handle at radius ${radius}`, () => assertVisibleTriangleContainment("push", radius, 1));
  for (const closure of Array.from({ length: 21 }, (_, i) => i / 20)) it(`contains every grasper triangle including articulated handle at closure ${closure}`, () => assertVisibleTriangleContainment("grasp", 3, closure));
});
