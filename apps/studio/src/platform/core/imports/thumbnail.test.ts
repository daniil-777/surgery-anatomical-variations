// The DOM-free half of the thumbnail renderer: which vertices are sampled and where the camera goes. The render itself
// needs WebGL and is checked in a real browser by px-imports-check.html.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { frameView, renderThumbnail, samplePoints } from "./thumbnail";

function project(points: Float32Array, camera: THREE.PerspectiveCamera): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < points.length; i += 3) out.push(new THREE.Vector3(points[i], points[i + 1], points[i + 2]).project(camera));
  return out;
}

function cameraFor(points: Float32Array, fov = 30): THREE.PerspectiveCamera {
  const framing = frameView(points, fov);
  if (!framing) throw new Error("no framing");
  const camera = new THREE.PerspectiveCamera(fov, 1, framing.near, framing.far);
  camera.position.copy(framing.target).addScaledVector(framing.back, framing.distance);
  camera.up.copy(framing.up);
  camera.lookAt(framing.target);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  return camera;
}

describe("samplePoints", () => {
  it("returns world positions of visible meshes, points and lines", () => {
    const root = new THREE.Group();
    root.position.set(10, 0, 0);
    root.scale.setScalar(2);
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    root.add(box);
    const hidden = new THREE.Mesh(new THREE.BoxGeometry(100, 100, 100));
    hidden.visible = false;
    root.add(hidden);
    const points = samplePoints(root);
    expect(points.length).toBe(24 * 3);
    const xs = Array.from(points).filter((_, i) => i % 3 === 0);
    expect(Math.min(...xs)).toBeCloseTo(9);
    expect(Math.max(...xs)).toBeCloseTo(11);
  });

  it("strides evenly to stay under the limit and counts every instance", () => {
    const geometry = new THREE.BoxGeometry(1, 1, 1, 10, 10, 10);
    const instanced = new THREE.InstancedMesh(geometry, new THREE.MeshBasicMaterial(), 3);
    for (let i = 0; i < 3; i++) instanced.setMatrixAt(i, new THREE.Matrix4().makeTranslation(i * 5, 0, 0));
    const all = samplePoints(instanced);
    expect(all.length / 3).toBe(geometry.getAttribute("position").count * 3);
    const xs = Array.from(all).filter((_, i) => i % 3 === 0);
    expect(Math.max(...xs)).toBeCloseTo(10.5);
    const sampled = samplePoints(instanced, 100);
    expect(sampled.length / 3).toBeLessThanOrEqual(100);
    expect(sampled.length / 3).toBeGreaterThan(50);
  });
});

describe("frameView", () => {
  it("fits every point inside the frame, centred, filling it on the longer side", () => {
    // A long, off-centre box: the perspective silhouette must still sit in the middle.
    const root = new THREE.Mesh(new THREE.BoxGeometry(4, 1, 0.5));
    root.position.set(30, -12, 7);
    const points = samplePoints(root);
    const projected = project(points, cameraFor(points));
    const xs = projected.map((point) => point.x);
    const ys = projected.map((point) => point.y);
    const reach = Math.max(...xs.map(Math.abs), ...ys.map(Math.abs));
    expect(reach).toBeLessThanOrEqual(0.85);
    expect(reach).toBeGreaterThan(0.8);
    expect(Math.abs((Math.min(...xs) + Math.max(...xs)) / 2)).toBeLessThan(0.03);
    expect(Math.abs((Math.min(...ys) + Math.max(...ys)) / 2)).toBeLessThan(0.03);
    for (const point of projected) expect(point.z).toBeGreaterThan(-1);
    for (const point of projected) expect(point.z).toBeLessThan(1);
  });

  it("frames a flat model and a single vertical line, and refuses points without extent", () => {
    const plane = samplePoints(new THREE.Mesh(new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2)));
    expect(frameView(plane, 30)).not.toBeNull();
    const line = new Float32Array([0, 0, 0, 0, 5, 0]);
    const camera = cameraFor(line);
    const reach = Math.max(...project(line, camera).map((point) => Math.abs(point.y)));
    expect(reach).toBeCloseTo(0.84, 1);
    expect(frameView(new Float32Array([1, 2, 3, 1, 2, 3]), 30)).toBeNull();
    expect(frameView(new Float32Array(), 30)).toBeNull();
  });
});

describe("renderThumbnail", () => {
  it("returns no image and says why where there is no DOM", async () => {
    expect(await renderThumbnail(new THREE.Mesh(new THREE.BoxGeometry()))).toEqual({ blob: null, note: "No thumbnail was rendered (no WebGL in this environment)." });
  });
});
