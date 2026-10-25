import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { CameraPose } from "./cameraRL";
import { buildCameraPoseGraph, interpolateScopePose } from "./cameraPoseGraph";
import { SceneNavigationGuard } from "./wholeSceneNavigation";

const start: CameraPose = { position: [0, 0, 0], direction: [0, 0, -1], up: [0, 1, 0], insertionMm: 70, yaw: 0, pitch: 0 };
const workspace = () => new THREE.Box3(new THREE.Vector3(-200, -200, -200), new THREE.Vector3(200, 200, 200));
const v = (value: number[]) => new THREE.Vector3(...value);

describe("fixed-port camera pose graph", () => {
  it("includes the exact current camera and 27 connected finite poses with only adjacent RCM actions", () => {
    const graph = buildCameraPoseGraph(start, new SceneNavigationGuard(() => []), workspace());
    expect(graph.nodes).toHaveLength(27); expect(graph.port).toEqual([0, 0, 70]); expect(graph.blockedEdges).toBe(0);
    expect(graph.nodes[0]).toEqual(start);
    expect(graph.edges.reduce((sum, edges) => sum + edges.length, 0)).toBe(108);
    for (let i = 0; i < graph.nodes.length; i++) {
      const pose = graph.nodes[i]!;
      expect(v(pose.position).distanceTo(v(graph.port))).toBeCloseTo(pose.insertionMm, 10);
      expect(v(pose.direction).length()).toBeCloseTo(1, 10); expect(v(pose.up).length()).toBeCloseTo(1, 10);
      for (const edge of graph.edges[i]!) {
        const destination = graph.nodes[edge.to]!;
        const changes = [pose.yaw !== destination.yaw, pose.pitch !== destination.pitch, pose.insertionMm !== destination.insertionMm].filter(Boolean);
        expect(changes).toHaveLength(1); expect(edge.distanceMm).toBeGreaterThan(0);
        expect(graph.edges[edge.to]!.find(other => other.to === i)).toEqual({ ...edge, to: i });
      }
    }
  });
  it("never teleports to insertion nodes beyond a thin two-sided sheet", () => {
    const plane = new THREE.PlaneGeometry(200, 200); plane.translate(0, 0, -12); plane.computeBoundingBox();
    try {
      const graph = buildCameraPoseGraph(start, new SceneNavigationGuard(() => [{ id: "thin-membrane", visible: true, geometry: plane }]), workspace());
      expect(graph.nodes.length).toBeLessThan(27); expect(graph.blockedEdges).toBeGreaterThan(0);
      expect(graph.nodes.every(pose => pose.position[2] > -10)).toBe(true);
      expect(graph.nodes.every(pose => pose.insertionMm <= 70)).toBe(true);
    } finally { plane.dispose(); }
  });
  it("checks the RCM arc, including an obstacle missed by the endpoint chord", () => {
    const empty = buildCameraPoseGraph(start, new SceneNavigationGuard(() => []), workspace());
    const a = empty.nodes.find(pose => pose.yaw === -.3 && pose.pitch === 0 && pose.insertionMm === 95)!;
    const b = empty.nodes.find(pose => pose.yaw === 0 && pose.pitch === 0 && pose.insertionMm === 95)!;
    const middle = interpolateScopePose(a, b, empty.port, .5);
    const center = v(middle.position).addScaledVector(v(middle.direction), 1.2);
    const sphere = new THREE.SphereGeometry(.1, 16, 12); sphere.translate(center.x, center.y, center.z); sphere.computeBoundingBox();
    try {
      const guard = new SceneNavigationGuard(() => [{ id: "arc-obstacle", visible: true, geometry: sphere }]);
      expect(guard.move(v(a.position), v(b.position), workspace()).blocked).toBe(false);
      const graph = buildCameraPoseGraph(start, guard, workspace());
      const ai = graph.nodes.findIndex(pose => pose.yaw === -.3 && pose.pitch === 0 && pose.insertionMm === 95);
      const bi = graph.nodes.findIndex(pose => pose.yaw === 0 && pose.pitch === 0 && pose.insertionMm === 95);
      expect(ai).toBeGreaterThanOrEqual(0); expect(bi).toBeGreaterThanOrEqual(0);
      expect(graph.edges[ai]!.some(edge => edge.to === bi)).toBe(false); expect(graph.blockedEdges).toBeGreaterThan(0);
    } finally { sphere.dispose(); }
  });
  it("uses the same constant-port interpolation throughout insertion, rotation and combined transitions", () => {
    const graph = buildCameraPoseGraph(start, new SceneNavigationGuard(() => []), workspace());
    for (const destination of graph.nodes) for (let i = 0; i <= 100; i++) {
      const pose = interpolateScopePose(start, destination, graph.port, i / 100);
      expect(v(pose.position).sub(v(pose.direction).multiplyScalar(pose.insertionMm)).distanceTo(v(graph.port))).toBeLessThan(1e-10);
      expect(v(pose.up).dot(v(pose.direction))).toBeCloseTo(0, 10);
      expect([...pose.position, ...pose.direction, ...pose.up].every(Number.isFinite)).toBe(true);
    }
  });
  it("respects bounded workspace and refuses a start intersecting a world surface", () => {
    const narrow = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    const graph = buildCameraPoseGraph(start, new SceneNavigationGuard(() => []), narrow);
    expect(graph.nodes).toHaveLength(1); expect(graph.edges).toEqual([[]]); expect(graph.blockedEdges).toBeGreaterThan(0);
    const sphere = new THREE.SphereGeometry(10, 24, 16); sphere.translate(0, 0, 10); sphere.computeBoundingBox();
    try {
      expect(() => buildCameraPoseGraph(start, new SceneNavigationGuard(() => [{ id: "tissue", visible: true, geometry: sphere }]), workspace())).toThrow(/away from tissue/);
      expect(() => buildCameraPoseGraph({ ...start, position: [NaN, 0, 0] }, new SceneNavigationGuard(() => []), workspace())).toThrow();
    } finally { sphere.dispose(); }
  });
});
