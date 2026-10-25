import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CameraPlannerScene, type CameraTrainingScene } from "./cameraPlannerScene";
import { SceneNavigationGuard } from "./wholeSceneNavigation";
import type { CameraPose, CameraViewNode } from "./cameraRL";

const sampler = vi.hoisted(() => ({ sample: vi.fn(), dispose: vi.fn() }));
vi.mock("./cameraRGBD", () => ({
  CAMERA_OBSERVATION_WIDTH: 64, CAMERA_OBSERVATION_HEIGHT: 48,
  CameraRGBDSampler: class {
    sample = sampler.sample;
    dispose = sampler.dispose;
  },
}));

const features = { luminance: .5, contrast: .2, glare: .01, dark: .02, depthP10: 20, depthMedian: 40, depthP90: 80, validDepth: .9, nearFraction: .01, sharpness: .3 };
const sample = () => ({ features: { ...features }, visibleMask: 1, quality: .8, rgb: [], depth: [], targetPixels: [100], targetCenterErrors: [.1], width: 64, height: 48 });
function pose(angle: number, insertionMm = 70): CameraPose {
  const direction = new THREE.Vector3(-Math.sin(angle), 0, -Math.cos(angle));
  return { position: direction.clone().multiplyScalar(insertionMm).toArray() as [number, number, number], direction: direction.toArray() as [number, number, number], up: [0, 1, 0], insertionMm, yaw: angle, pitch: 0 };
}
function fixture() {
  const camera = new THREE.PerspectiveCamera(46, 1.5, .1, 1000), initial = pose(0);
  camera.position.fromArray(initial.position); camera.up.fromArray(initial.up); camera.lookAt(camera.position.clone().add(new THREE.Vector3(...initial.direction))); camera.updateMatrixWorld();
  const controls = { enabled: true, target: camera.position.clone().addScaledVector(new THREE.Vector3(...initial.direction), 40) } as unknown as OrbitControls;
  const bounds = new THREE.Box3(new THREE.Vector3(-200, -200, -200), new THREE.Vector3(200, 200, 200));
  const geometry = new THREE.PlaneGeometry(100, 100).translate(0, 150, 0); geometry.computeBoundingBox();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  const surfaces: { id: string; visible: boolean; geometry: THREE.BufferGeometry }[] = [];
  const guard = new SceneNavigationGuard(() => surfaces), publish = vi.fn(), changed = vi.fn(), light = vi.fn(), restoreLight = vi.fn();
  const planner = new CameraPlannerScene({ renderer: {} as THREE.WebGLRenderer, scene: new THREE.Scene(), camera, controls,
    parts: () => [{ info: { id: "target", label: "Visible target" }, mesh, materialSignature: "unchanged-material" }],
    guard, bounds: () => bounds, light, restoreLight, publish, changed });
  const nodes: CameraViewNode[] = [pose(0), pose(.4), pose(.4, 45)].map((value, id) => ({ id, pose: value, features: { ...features }, visibleMask: id === 2 ? 1 : 0, quality: .8, clearanceMm: 100 }));
  const map: CameraTrainingScene = {
    graph: { version: "test-rgbd-graph/1", fingerprint: "fixture", nodes, edges: [[{ to: 1, distanceMm: 28, angleRad: .4 }], [{ to: 0, distanceMm: 28, angleRad: .4 }, { to: 2, distanceMm: 25, angleRad: 0 }], [{ to: 1, distanceMm: 25, angleRad: 0 }]], targets: [{ id: "target", label: "Visible target" }], startNode: 0, observation: { width: 64, height: 48, near: .1, far: 650 } },
    port: [0, 0, 0], workspace: { min: bounds.min.toArray(), max: bounds.max.toArray() }, revision: 0, fov: 46,
    captureMs: 0, graphMs: 0, blockedEdges: 0, captureTimesMs: [], targetPixels: [], observationConvention: "test metric RGBD",
  };
  return { planner, camera, controls, map, guard, surfaces, publish, changed, light, restoreLight, geometry, mesh };
}
function cameraState(camera: THREE.PerspectiveCamera, controls: OrbitControls) {
  return { position: camera.position.toArray(), quaternion: camera.quaternion.toArray(), up: camera.up.toArray(), fov: camera.fov, near: camera.near, far: camera.far, aspect: camera.aspect, target: controls.target.toArray() };
}
beforeEach(() => {
  sampler.sample.mockReset().mockImplementation(async () => sample()); sampler.dispose.mockReset();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(performance.now()); return 1; });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("camera planner render-thread replay bridge", () => {
  it("loops 50 times through guarded returns without a teleport, drift or unbounded path storage", () => {
    const { planner, map, camera, guard, controls } = fixture(), move = vi.spyOn(guard, "move");
    planner.play(map, [0, 1, 2], { loop: true });
    let frames = 0, priorLap = 1, wraps = 0;
    while (planner.snapshot().lap < 51 && frames++ < 15000) {
      const previous = camera.position.clone(); planner.tick(1 / 30);
      const state = planner.snapshot();
      expect(camera.position.distanceTo(previous)).toBeLessThanOrEqual(24 / 30 + 1e-6);
      expect(state.phase).toBe("playing"); expect(state.blockedMoves).toBe(0); expect(state.path.length).toBeLessThanOrEqual(5);
      expect(camera.position.clone().normalize().distanceTo(camera.getWorldDirection(new THREE.Vector3()))).toBeLessThan(1e-10);
      expect(move.mock.results.at(-1)!.value.blocked).toBe(false);
      if (state.lap !== priorLap) { wraps++; expect(state.returnSegments).toBe(2); expect(state.message).toMatch(/returning/i); priorLap = state.lap; }
    }
    expect(wraps).toBe(50); expect(controls.enabled).toBe(false);
    planner.pause(); const paused = camera.position.clone(); planner.tick(5); expect(camera.position.equals(paused)).toBe(true);
    planner.pause(); planner.stop(); planner.tick(5); expect(camera.position.equals(paused)).toBe(true); expect(controls.enabled).toBe(true);
  });

  it("stops a running loop before a newly obstructed return and rejects nonmoving loops", () => {
    const { planner, map, camera, guard, surfaces } = fixture();
    expect(() => planner.play(map, [0], { loop: true })).toThrow(/no movement/);
    planner.play(map, [0, 1, 2], { loop: true });
    while (planner.snapshot().segment < 2) planner.tick(.05);
    const wall = new THREE.PlaneGeometry(120, 120).translate(0, 0, -55); wall.computeBoundingBox();
    surfaces.push({ id: "new-return-obstruction", visible: true, geometry: wall }); guard.invalidate();
    for (let frame = 0; frame < 200 && planner.playing; frame++) planner.tick(.05);
    expect(planner.snapshot()).toMatchObject({ phase: "blocked", blockedMoves: 1, lap: 2 });
    expect(camera.position.z).toBeGreaterThan(-53); const stopped = camera.position.clone();
    planner.tick(.05); expect(camera.position.equals(stopped)).toBe(true);
  });

  it("executes guarded curve segments around one fixed port without using the renderer", () => {
    const { planner, camera, controls, map, guard, changed } = fixture(), move = vi.spyOn(guard, "move");
    const before = cameraState(camera, controls);
    planner.play(map, [0, 1, 2]); expect(cameraState(camera, controls)).toEqual(before); expect(controls.enabled).toBe(false);
    let frames = 0;
    while (planner.playing && frames++ < 300) {
      const previous = camera.position.clone();
      if (!planner.tick(.05)) continue;
      const outward = camera.position.clone().sub(new THREE.Vector3(...map.port)).normalize();
      expect(outward.distanceTo(camera.getWorldDirection(new THREE.Vector3()))).toBeLessThan(1e-10);
      expect(camera.position.distanceTo(previous)).toBeLessThan(1.3);
      expect(camera.up.dot(outward)).toBeCloseTo(0, 10);
      expect(camera.quaternion.length()).toBeCloseTo(1, 10);
      const result = move.mock.results.at(-1)?.value;
      expect(result.blocked).toBe(false); expect(result.position.distanceTo(camera.position)).toBeLessThan(1e-10);
      expect(move.mock.calls.at(-1)?.[3]).toBeGreaterThanOrEqual(2);
    }
    expect(frames).toBeLessThan(300); expect(planner.snapshot().phase).toBe("complete"); expect(controls.enabled).toBe(true);
    expect(camera.position.distanceTo(new THREE.Vector3(...map.graph.nodes[2]!.pose.position))).toBeLessThan(1e-9);
    expect(changed.mock.calls.length).toBeGreaterThan(20); expect(move.mock.calls.length).toBe(changed.mock.calls.length);
    expect(sampler.sample).not.toHaveBeenCalled();
  });

  it("pauses, resumes and cancels at the current pose without later camera movement", () => {
    const { planner, camera, controls, map } = fixture(); planner.play(map, [0, 1, 2]);
    expect(planner.moving).toBe(true);
    for (let i = 0; i < 10; i++) planner.tick(.05);
    planner.pause(); const paused = cameraState(camera, controls);
    expect(planner.snapshot().phase).toBe("paused"); expect(planner.moving).toBe(false); expect(planner.playing).toBe(true); expect(planner.busy).toBe(true);
    expect(planner.tick(10)).toBe(false); expect(cameraState(camera, controls)).toEqual(paused);
    planner.pause(); expect(planner.snapshot().phase).toBe("playing"); expect(planner.moving).toBe(true); expect(planner.tick(.05)).toBe(true);
    expect(cameraState(camera, controls).position).not.toEqual(paused.position);
    planner.stop(); const stopped = cameraState(camera, controls);
    expect(planner.playing).toBe(false); expect(planner.moving).toBe(false); expect(controls.enabled).toBe(true); expect(planner.tick(.05)).toBe(false);
    expect(cameraState(camera, controls)).toEqual(stopped);
    // Restart can return to the route start through captured graph edges once
    // the current camera matches a captured node; no free-space teleport.
    expect(() => planner.play(map, [0, 1])).toThrow(/moved away/);
  });

  it("returns through captured edges before replaying a route from another graph node", () => {
    const { planner, camera, controls, map } = fixture(), start = map.graph.nodes[2]!.pose;
    camera.position.fromArray(start.position); camera.up.fromArray(start.up);
    controls.target.copy(camera.position).addScaledVector(new THREE.Vector3(...start.direction), 40); camera.lookAt(controls.target);
    const before = cameraState(camera, controls);
    planner.play(map, [0, 1]); expect(cameraState(camera, controls)).toEqual(before);
    // Prefix 2→1→0 is a real guarded return; the requested policy then follows
    // 0→1. These two prefix edges must be counted in playback telemetry.
    expect(planner.snapshot()).toMatchObject({ segments: 3, returnSegments: 2, returnDistanceMm: 53 });
    expect(planner.snapshot().message).toMatch(/returning/i);
    planner.pause(); planner.pause(); expect(planner.snapshot().message).toMatch(/returning/i);
    expect(planner.tick(.05)).toBe(true); expect(camera.position.length()).toBeGreaterThan(45);
    expect(camera.getWorldDirection(new THREE.Vector3()).distanceTo(new THREE.Vector3(...start.direction))).toBeLessThan(1e-10);
    let frames = 0, observedPolicyStart = false;
    while (planner.playing && frames++ < 400) {
      planner.tick(.05);
      if (planner.snapshot().segment === 2) { observedPolicyStart = true; expect(planner.snapshot().message).toMatch(/following the selected policy/i); }
    }
    expect(observedPolicyStart).toBe(true);
    expect(planner.snapshot().phase).toBe("complete"); expect(planner.snapshot().segment).toBe(3);
    expect(camera.position.distanceTo(new THREE.Vector3(...map.graph.nodes[1]!.pose.position))).toBeLessThan(1e-9);
  });

  it("stops before a new tissue sheet crossing the curve despite safe endpoints", () => {
    const { planner, camera, controls, map, surfaces, guard } = fixture();
    const wall = new THREE.PlaneGeometry(120, 120).rotateY(Math.PI / 2).translate(-14, 0, -70); wall.computeBoundingBox();
    surfaces.push({ id: "new-tissue-sheet", visible: true, geometry: wall });
    expect(guard.closest(new THREE.Vector3(...map.graph.nodes[0]!.pose.position), 2.01)).toBeNull();
    expect(guard.closest(new THREE.Vector3(...map.graph.nodes[1]!.pose.position), 2.01)).toBeNull();
    planner.play(map, [0, 1]); let last = camera.position.clone(), blockedPose = last;
    for (let frame = 0; frame < 200 && planner.playing; frame++) {
      last = camera.position.clone(); const moved = planner.tick(.05);
      if (!moved && planner.snapshot().phase === "blocked") blockedPose = camera.position.clone();
    }
    expect(planner.snapshot()).toMatchObject({ phase: "blocked", blockedMoves: 1 });
    expect(planner.snapshot().message).toContain("new-tissue-sheet"); expect(blockedPose.equals(last)).toBe(true);
    expect(camera.position.x).toBeGreaterThan(-14 + 2); expect(controls.enabled).toBe(true);
    expect(planner.tick(.05)).toBe(false); expect(camera.position.equals(blockedPose)).toBe(true);
  });

  it("rejects malformed, non-edge and stale routes before changing any camera pose", () => {
    const { planner, camera, controls, map } = fixture(), original = cameraState(camera, controls);
    for (const route of [[], [99], [NaN], [0, 2], Array.from({ length: 258 }, () => 0)]) {
      expect(() => planner.play(map, route)).toThrow(); expect(cameraState(camera, controls)).toEqual(original);
      expect(planner.playing).toBe(false); expect(controls.enabled).toBe(true);
    }
    planner.invalidate("Anatomy changed"); expect(() => planner.play(map, [0, 1])).toThrow(/scene changed/i);
    expect(cameraState(camera, controls)).toEqual(original);
  });

  it("coalesces repeated deformation invalidations while idle and after stopping playback", () => {
    const { planner, map, publish, changed, camera, controls } = fixture();
    for (let frame = 0; frame < 120; frame++) planner.invalidate("Deformation changed the map");
    expect(publish).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled(); expect(planner.snapshot().revision).toBe(120);
    map.revision = 120; planner.play(map, [0, 1]); planner.tick(.05); const original = cameraState(camera, controls);
    planner.invalidate("Deformation changed the map"); const publications = publish.mock.calls.length, wakeups = changed.mock.calls.length;
    for (let frame = 0; frame < 120; frame++) planner.invalidate("Deformation changed the map");
    expect(publish).toHaveBeenCalledTimes(publications); expect(changed).toHaveBeenCalledTimes(wakeups);
    expect(planner.snapshot().phase).toBe("invalidated"); expect(planner.tick(.05)).toBe(false); expect(cameraState(camera, controls)).toEqual(original);
  });

  it("cancels before capture without constructing GPU work or altering the source pose", async () => {
    const { planner, camera, controls, restoreLight } = fixture(), original = cameraState(camera, controls), abort = new AbortController(); abort.abort();
    await expect(planner.capture(["target"], abort.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(sampler.sample).not.toHaveBeenCalled(); expect(cameraState(camera, controls)).toEqual(original);
    expect(planner.capturing).toBe(false); expect(planner.snapshot().phase).toBe("stopped"); expect(controls.enabled).toBe(true); expect(restoreLight).toHaveBeenCalled();
  });

  it("cancels pending observation readback and preserves the source view and anatomy", async () => {
    const { planner, camera, controls, geometry, restoreLight } = fixture(), original = cameraState(camera, controls), positions = Array.from(geometry.getAttribute("position").array);
    let resolve!: (value: ReturnType<typeof sample>) => void;
    sampler.sample.mockImplementationOnce(() => new Promise<ReturnType<typeof sample>>(done => { resolve = done; }));
    const pending = planner.capture(["target"]); expect(planner.capturing).toBe(true); expect(sampler.sample).toHaveBeenCalledTimes(1);
    planner.stop(); resolve(sample());
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cameraState(camera, controls)).toEqual(original); expect(Array.from(geometry.getAttribute("position").array)).toEqual(positions);
    expect(planner.capturing).toBe(false); expect(planner.snapshot().phase).toBe("stopped"); expect(sampler.dispose).toHaveBeenCalledTimes(1); expect(restoreLight).toHaveBeenCalled();
    // Cancellation is scoped to one job; a fresh capture can finish normally.
    const next = await planner.capture(["target"]); expect(next.graph.nodes.length).toBeGreaterThan(1); expect(cameraState(camera, controls)).toEqual(original);
  });

  it("recovers from a non-abort readback failure and can capture again", async () => {
    const { planner, camera, controls, geometry, restoreLight, publish } = fixture(), original = cameraState(camera, controls), positions = Array.from(geometry.getAttribute("position").array);
    sampler.sample.mockRejectedValueOnce(new Error("RGBD readback unavailable"));
    await expect(planner.capture(["target"])).rejects.toThrow("RGBD readback unavailable");
    expect(planner.capturing).toBe(false); expect(planner.busy).toBe(false); expect(planner.snapshot().phase).toBe("stopped");
    expect(controls.enabled).toBe(true); expect(cameraState(camera, controls)).toEqual(original);
    expect(Array.from(geometry.getAttribute("position").array)).toEqual(positions);
    expect(sampler.dispose).toHaveBeenCalledTimes(1); expect(restoreLight).toHaveBeenCalled();
    expect(publish.mock.calls.some(([state]) => state.phase === "ready")).toBe(false);
    const map = await planner.capture(["target"]);
    expect(map.graph.nodes.length).toBeGreaterThan(1); expect(planner.snapshot().phase).toBe("ready"); expect(cameraState(camera, controls)).toEqual(original);
  });

  it("rejects concurrent capture and playback while a readback is pending", async () => {
    const { planner, map, camera, controls } = fixture(), original = cameraState(camera, controls);
    let resolve!: (value: ReturnType<typeof sample>) => void;
    sampler.sample.mockImplementationOnce(() => new Promise<ReturnType<typeof sample>>(done => { resolve = done; }));
    const pending = planner.capture(["target"]);
    await expect(planner.capture(["target"])).rejects.toThrow(/stop the current camera operation/i);
    expect(() => planner.play(map, [0, 1])).toThrow(/observation capture/i);
    expect(sampler.sample).toHaveBeenCalledTimes(1); expect(cameraState(camera, controls)).toEqual(original);
    planner.stop(); resolve(sample()); await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(planner.busy).toBe(false); expect(controls.enabled).toBe(true);
  });

  it("rejects an observation map atomically when source geometry changes during capture", async () => {
    const { planner, camera, controls, geometry, publish } = fixture(), original = cameraState(camera, controls);
    const pending = planner.capture(["target"], undefined, done => {
      if (done === 1) {
        const position = geometry.getAttribute("position"); position.setX(0, position.getX(0) + 1);
      }
    });
    await expect(pending).rejects.toThrow(/anatomy changed during capture/i);
    expect(planner.capturing).toBe(false); expect(planner.snapshot().phase).toBe("stopped"); expect(controls.enabled).toBe(true);
    expect(cameraState(camera, controls)).toEqual(original);
    expect(publish.mock.calls.some(([state]) => state.phase === "ready")).toBe(false);
  });

  it("coalesces invalidations even while an aborted observation readback remains pending", async () => {
    const { planner, publish, changed } = fixture(); let resolve!: (value: ReturnType<typeof sample>) => void;
    sampler.sample.mockImplementationOnce(() => new Promise<ReturnType<typeof sample>>(done => { resolve = done; }));
    const pending = planner.capture(["target"]); planner.invalidate("Tissue moved");
    const publications = publish.mock.calls.length, wakeups = changed.mock.calls.length;
    for (let frame = 0; frame < 120; frame++) planner.invalidate("Tissue moved");
    // Resolve before assertions so a failure cannot leave an unhandled job.
    resolve(sample()); await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(publish.mock.calls.length).toBe(publications); expect(changed.mock.calls.length).toBe(wakeups + 1);
  });
});
