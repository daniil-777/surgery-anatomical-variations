import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { orientLumenCamera } from "./lumenPath";
import { createLumenWalkthrough } from "./geometry";

const pose = { position: new THREE.Vector3(12, 4, -3), target: new THREE.Vector3(12, 4, -23), up: new THREE.Vector3(0, 1, 0) };
describe("all-direction lumen inspection", () => {
  it("looks backward and at both poles without translating or mutating its safe pose", () => {
    const original = pose.target.clone(), forward = pose.target.clone().sub(pose.position).normalize();
    for (const yaw of [-180, -90, 0, 90, 180]) for (const pitch of [-90, -45, 0, 45, 90]) {
      const output = orientLumenCamera(pose, yaw, pitch), direction = output.target.clone().sub(output.position).normalize();
      expect(output.position.equals(pose.position)).toBe(true);
      expect(Math.abs(direction.dot(output.up))).toBeLessThan(1e-12);
      expect(output.up.length()).toBeCloseTo(1, 12);
      expect(output.target.distanceTo(output.position)).toBeCloseTo(20, 12);
      expect([...direction.toArray(), ...output.up.toArray()].every(Number.isFinite)).toBe(true);
      if (Math.abs(yaw) === 180 && pitch === 0) expect(direction.dot(forward)).toBeCloseTo(-1, 12);
    }
    expect(pose.target.equals(original)).toBe(true);
    expect(orientLumenCamera(pose, -180).target.distanceTo(orientLumenCamera(pose, 180).target)).toBeLessThan(1e-12);
  });
  it("rejects nonfinite or out-of-range angles before constructing a camera frame", () => {
    for (const [yaw, pitch] of [[NaN, 0], [0, Infinity], [181, 0], [0, -91]]) expect(() => orientLumenCamera(pose, yaw, pitch)).toThrow();
  });
  it.each(["colon", "small-bowel", "gastric"] as const)("%s preserves whole-loop replay and safe directional rays at reverse, side and pole orientations", profile => {
    const model = createLumenWalkthrough(43, { profile }), mesh = new THREE.Mesh(model.geometry, new THREE.MeshBasicMaterial({ side: THREE.FrontSide }));
    mesh.updateMatrixWorld();
    for (const direction of [{ yawDeg: 0, pitchDeg: 0 }, { yawDeg: 180, pitchDeg: 0 }, { yawDeg: -90, pitchDeg: 0 }, { yawDeg: 90, pitchDeg: 0 }, { yawDeg: 0, pitchDeg: 90 }, { yawDeg: 0, pitchDeg: -90 }]) {
      const first = model.sampleCamera(0, 18, direction), last = model.sampleCamera(model.metadata.loopPeriodSeconds, 18, direction);
      for (const key of ["position", "target", "up"] as const) expect(first[key].distanceTo(last[key])).toBeLessThan(1e-9);
      for (const time of [0, 13, 47]) {
        const sample = model.sampleCamera(time, 18, direction), ray = sample.target.clone().sub(sample.position).normalize();
        const hit = new THREE.Raycaster(sample.position, ray, 0, 800).intersectObject(mesh)[0];
        expect(hit).toBeDefined(); expect(hit!.distance).toBeGreaterThan(8);
      }
    }
    model.geometry.dispose(); (mesh.material as THREE.Material).dispose();
  });
});
