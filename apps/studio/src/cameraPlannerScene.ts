import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CameraRGBDSampler, CAMERA_OBSERVATION_WIDTH, CAMERA_OBSERVATION_HEIGHT } from "./cameraRGBD";
import { buildCameraPoseGraph, interpolateScopePose } from "./cameraPoseGraph";
import type { CameraPose, CameraViewGraph } from "./cameraRL";
import { SceneNavigationGuard, NAVIGATION_CLEARANCE_MM } from "./wholeSceneNavigation";
import { sceneBufferSignature } from "./wholeSceneModel";

export interface CameraTrainingScene {
  graph: CameraViewGraph; port: [number, number, number]; workspace: { min: number[]; max: number[] };
  revision: number; fov: number; captureMs: number; graphMs: number; blockedEdges: number;
  captureTimesMs: number[]; targetPixels: number[][];
  targetCenterErrors?: number[][]; targetDepths?: number[][];
  lightIntensities?: number[];
  goal?: { id: string; label: string; node: number; score: number; initialScore: number; areaFraction: number; centerError: number; depthMm: number };
  observationConvention: string;
}
export interface CameraPlannerState {
  phase: "idle" | "capturing" | "ready" | "playing" | "paused" | "stopped" | "invalidated" | "blocked" | "complete";
  message: string; revision: number; captured: number; total: number; segment: number; segments: number;
  elapsedSeconds: number; returnSegments: number; returnDistanceMm: number; clearanceMm: number; blockedMoves: number; positionMm: number[]; direction: number[]; port: number[] | null;
  loop: boolean; lap: number; path: number[][]; targetLabel: string | null;
}
export interface CameraPlaybackOptions { loop?: boolean }
export interface CameraCaptureOptions { approachTarget?: string }
interface Part { info: { id: string; label: string }; mesh: THREE.Mesh; materialSignature: string }
interface Options {
  renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; controls: OrbitControls;
  parts: () => Part[]; guard: SceneNavigationGuard; bounds: () => THREE.Box3;
  light: (camera: THREE.PerspectiveCamera, intensity?: number) => void; restoreLight: () => void; setIntensity?: (intensity: number) => void;
  changed: () => void; publish: (state: CameraPlannerState) => void;
}
const tuple = (v: THREE.Vector3): [number, number, number] => [v.x, v.y, v.z];
const aborted = () => new DOMException("Camera map capture cancelled.", "AbortError");
function hash(value: string) { let h = 2166136261; for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619); return (h >>> 0).toString(16).padStart(8, "0"); }
function shortestPath(graph: CameraViewGraph, start: number, end: number): number[] {
  const queue = [start], previous = new Map<number, number>([[start, -1]]);
  for (let i = 0; i < queue.length && !previous.has(end); i++) for (const edge of graph.edges[queue[i]!]!) if (!previous.has(edge.to)) { previous.set(edge.to, queue[i]!); queue.push(edge.to); }
  if (!previous.has(end)) throw new Error("The current camera cannot return through the captured graph.");
  const result = [end]; while (result[0] !== start) result.unshift(previous.get(result[0]!)!); return result;
}

/** The render-thread bridge owns capture and guarded replay. The learner runs
 * separately in a Worker and cannot move or mutate the scene. */
export class CameraPlannerScene {
  private revision = 0;
  private captureAbort: AbortController | null = null;
  private playback: { scene: CameraTrainingScene; route: number[]; cycle: number[]; cycleReturnSegments: number; cycleReturnDistance: number; loop: boolean; segment: number; time: number; elapsed: number; paused: boolean; returnSegments: number } | null = null;
  private state: Omit<CameraPlannerState, "positionMm" | "direction" | "revision"> = { phase: "idle", message: "Prepare an operative view, then capture RGB + depth.", captured: 0, total: 0, segment: 0, segments: 0, elapsedSeconds: 0, returnSegments: 0, returnDistanceMm: 0, clearanceMm: NAVIGATION_CLEARANCE_MM, blockedMoves: 0, port: null, loop: false, lap: 0, path: [], targetLabel: null };
  private lastPublish = 0;
  constructor(private readonly options: Options) {}
  get capturing() { return this.captureAbort !== null; }
  get playing() { return this.playback !== null; }
  get moving() { return this.playback !== null && !this.playback.paused; }
  get busy() { return this.capturing || this.playing; }
  snapshot(): CameraPlannerState { return { ...this.state, revision: this.revision, positionMm: this.options.camera.position.toArray(), direction: this.options.camera.getWorldDirection(new THREE.Vector3()).toArray() }; }
  private publish(force = true) { if (force || performance.now() - this.lastPublish > 100) { this.lastPublish = performance.now(); this.options.publish(this.snapshot()); } }
  private signature() {
    return hash(this.options.parts().map(part => `${part.info.id}:${part.mesh.visible}:${sceneBufferSignature(part.mesh.geometry.getAttribute("position").array as Float32Array)}:${part.materialSignature}`).join("|"));
  }
  invalidate(reason: string) {
    this.revision++;
    // Deformation may update at 60 Hz. One stale-map notification is enough;
    // keep the normal simulation out of React and avoid waking an idle viewer.
    if (this.state.phase !== "invalidated" && (this.busy || this.state.phase !== "idle")) {
      this.stop(reason); this.state.phase = "invalidated"; this.publish();
    }
  }
  stop(message = "Camera path stopped. Your current view is retained.") {
    this.captureAbort?.abort(); this.playback = null;
    this.options.controls.enabled = true;
    this.state.phase = "stopped"; this.state.message = message; this.publish(); this.options.changed();
  }
  pause() {
    if (!this.playback) return;
    this.playback.paused = !this.playback.paused;
    this.state.phase = this.playback.paused ? "paused" : "playing"; this.state.message = this.playback.paused ? "Path paused at the current scope pose." : this.playback.segment < this.playback.returnSegments ? "Returning to the captured start via guarded graph edges." : "Following the selected policy path."; this.publish();
  }
  async capture(targetIds: string[], signal?: AbortSignal, progress?: (done: number, total: number) => void, options: CameraCaptureOptions = {}): Promise<CameraTrainingScene> {
    if (this.busy) throw new Error("Stop the current camera operation before capturing another map.");
    if (targetIds.length < 1 || targetIds.length > 6 || new Set(targetIds).size !== targetIds.length) throw new Error("Choose one to six distinct camera landmarks.");
    const parts = this.options.parts(), targets = targetIds.map(id => {
      const part = parts.find(p => p.info.id === id && p.mesh.visible);
      if (!part) throw new Error(`The camera landmark ${id} is hidden or unavailable.`);
      return { id, label: part.info.label };
    });
    const controller = new AbortController(); this.captureAbort = controller;
    const cancel = () => controller.abort(); signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) controller.abort();
    const check = () => { if (controller.signal.aborted) throw aborted(); };
    const revision = this.revision, began = performance.now();
    this.options.controls.enabled = false;
    this.state = { ...this.state, phase: "capturing", message: "Validating a fixed-pivot scope map…", captured: 0, total: 27, segment: 0, segments: 0, elapsedSeconds: 0, returnSegments: 0, returnDistanceMm: 0, blockedMoves: 0, loop: false, lap: 0, path: [] };
    this.publish();
    let sampler: CameraRGBDSampler | null = null;
    try {
      check();
      const camera = this.options.camera, forward = camera.getWorldDirection(new THREE.Vector3()).normalize();
      const pose: CameraPose = { position: tuple(camera.position), direction: tuple(forward), up: tuple(camera.up.clone().normalize()), insertionMm: 70, yaw: 0, pitch: 0 };
      const graphBegan = performance.now();
      let approach: { target: [number, number, number]; port?: [number, number, number] } | undefined;
      if (options.approachTarget) {
        const part = parts.find(p => p.info.id === options.approachTarget && p.mesh.visible);
        if (!part || !targetIds.includes(part.info.id)) throw new Error("Choose a visible organ for camera approach learning.");
        part.mesh.geometry.computeBoundingBox(); part.mesh.updateWorldMatrix(true, false);
        const center = part.mesh.geometry.boundingBox!.getCenter(new THREE.Vector3()).applyMatrix4(part.mesh.matrixWorld);
        approach = { target: tuple(center) };
        if (this.state.port) {
          const fromPort = camera.position.clone().sub(new THREE.Vector3().fromArray(this.state.port));
          if (fromPort.length() > 1 && fromPort.normalize().distanceTo(forward) < 1e-6) approach.port = [...this.state.port] as [number, number, number];
        }
      }
      const poses = buildCameraPoseGraph(pose, this.options.guard, this.options.bounds(), approach);
      const graphMs = performance.now() - graphBegan;
      check();
      if (poses.nodes.length < 2) throw new Error("No safe scope movement is available here. Prepare another operative camera view.");
      const fingerprint = this.signature(), observationCamera = camera.clone();
      observationCamera.aspect = CAMERA_OBSERVATION_WIDTH / CAMERA_OBSERVATION_HEIGHT; observationCamera.near = .1; observationCamera.far = 650; observationCamera.updateProjectionMatrix();
      sampler = new CameraRGBDSampler(this.options.renderer, this.options.scene, parts.map(p => ({ id: p.info.id, mesh: p.mesh })), targets);
      const nodes: CameraViewGraph["nodes"] = [], captureTimesMs: number[] = [], targetPixels: number[][] = [], targetCenterErrors: number[][] = [], targetDepths: number[][] = [], lightIntensities: number[] = [];
      for (let id = 0; id < poses.nodes.length; id++) {
        check();
        const view = poses.nodes[id]!;
        observationCamera.position.fromArray(view.position); observationCamera.up.fromArray(view.up); observationCamera.lookAt(new THREE.Vector3(...view.position).add(new THREE.Vector3(...view.direction))); observationCamera.updateMatrixWorld();
        // The same inverse-square compensation already used by interior
        // navigation prevents the close approach washing out wet tissue.
        const intensity = approach ? THREE.MathUtils.clamp(this.options.guard.rayDistance(observationCamera.position, new THREE.Vector3(...view.direction), 240), 22, 240) ** 2 * 3.4 : undefined;
        if (intensity !== undefined) lightIntensities.push(intensity);
        this.options.light(observationCamera, intensity);
        const sampleBegan = performance.now(), pending = sampler.sample(observationCamera, controller.signal);
        this.options.restoreLight();
        const sample = await pending;
        captureTimesMs.push(performance.now() - sampleBegan); targetPixels.push(sample.targetPixels);
        targetCenterErrors.push(sample.targetCenterErrors.map(value => Number.isFinite(value) ? value : 1)); targetDepths.push(sample.targetDepths ?? targets.map(() => 0));
        check();
        const closest = this.options.guard.closest(observationCamera.position, 100);
        nodes.push({ id, pose: view, features: sample.features, visibleMask: sample.visibleMask, quality: sample.quality,
          clearanceMm: closest?.distanceMm ?? 100, rgb: sample.rgb, depth: sample.depth });
        this.state.captured = id + 1; this.state.total = poses.nodes.length; this.state.message = `RGB + depth captured · ${id + 1} / ${poses.nodes.length} views`;
        progress?.(id + 1, poses.nodes.length); this.publish();
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      }
      check();
      if (revision !== this.revision || fingerprint !== this.signature()) throw new Error("The anatomy changed during capture. Capture a fresh map.");
      const identity = hash(JSON.stringify({ fingerprint, port: poses.port, fov: camera.fov, nodes: nodes.map(n => ({ pose: n.pose, features: n.features, mask: n.visibleMask })), targets }));
      const result: CameraTrainingScene = { graph: { version: "viscera.camera-rgbd-rcm-graph/1", fingerprint: `${fingerprint}-${identity}`, nodes, edges: poses.edges, targets, startNode: 0,
        observation: { width: CAMERA_OBSERVATION_WIDTH, height: CAMERA_OBSERVATION_HEIGHT, near: observationCamera.near, far: observationCamera.far } },
        port: poses.port, workspace: { min: poses.workspace.min.toArray(), max: poses.workspace.max.toArray() }, revision, fov: camera.fov,
        captureMs: performance.now() - began, graphMs, captureTimesMs, blockedEdges: poses.blockedEdges, targetPixels, targetCenterErrors, targetDepths, ...(approach ? { lightIntensities } : {}),
        observationConvention: "64×48 rendered tissue RGB before HDR glare; linear optical depth; map-derived semantic landmarks; centered inspection mask; fixed inferred port and 0° virtual scope" };
      this.state.phase = "ready"; this.state.port = poses.port; this.state.message = `${nodes.length} RGBD views captured. The live camera was preserved.`; this.publish();
      return result;
    } catch (error) {
      if (this.state.phase === "capturing" && !controller.signal.aborted) { this.state.phase = "stopped"; this.state.message = error instanceof Error ? error.message : "Camera map capture failed."; this.publish(); }
      throw error;
    } finally {
      sampler?.dispose(); signal?.removeEventListener("abort", cancel); this.options.restoreLight();
      if (this.captureAbort === controller) this.captureAbort = null;
      this.options.controls.enabled = true; this.options.changed();
      if (controller.signal.aborted && this.state.phase === "capturing") { this.state.phase = "stopped"; this.state.message = "Map capture cancelled; previous camera and anatomy preserved."; this.publish(); }
    }
  }
  play(scene: CameraTrainingScene, requestedRoute: number[], options: CameraPlaybackOptions = {}) {
    if (this.capturing) throw new Error("Wait for observation capture to finish.");
    if (scene.revision !== this.revision) throw new Error("The scene changed. Capture and train a fresh camera map.");
    if (!requestedRoute.length || requestedRoute.length > 257 || requestedRoute.some(id => !Number.isInteger(id) || !scene.graph.nodes[id])) throw new Error("Invalid camera policy route.");
    for (let i = 1; i < requestedRoute.length; i++) if (!scene.graph.edges[requestedRoute[i - 1]!]!.some(edge => edge.to === requestedRoute[i])) throw new Error("The policy requested an edge outside its guarded map.");
    if (scene.lightIntensities && (scene.lightIntensities.length !== scene.graph.nodes.length || scene.lightIntensities.some(value => !Number.isFinite(value) || value < 0 || value > 200000))) throw new Error("Invalid camera illumination profile.");
    if (options.loop && requestedRoute.length < 2) throw new Error("This policy needs no movement. Choose a different starting view before looping.");
    const current = this.options.camera, direction = current.getWorldDirection(new THREE.Vector3());
    const start = scene.graph.nodes.find(node => current.position.distanceTo(new THREE.Vector3(...node.pose.position)) < .6 && direction.angleTo(new THREE.Vector3(...node.pose.direction)) < .015);
    if (!start) throw new Error("The camera moved away from the captured map. Use the original operative view or capture a new map.");
    const prefix = shortestPath(scene.graph, start.id, requestedRoute[0]!), returnSegments = prefix.length - 1;
    const returnDistanceMm = prefix.slice(1).reduce((sum, id, i) => sum + scene.graph.edges[prefix[i]!]!.find(edge => edge.to === id)!.distanceMm, 0);
    const route = [...prefix, ...requestedRoute.slice(1)];
    // A cycle returns along actual guarded edges. Never jump from the last
    // camera pose to the first or label the return as a learned action.
    const closing = options.loop ? shortestPath(scene.graph, requestedRoute.at(-1)!, requestedRoute[0]!) : [];
    const cycle = [...closing, ...requestedRoute.slice(1)], cycleReturnSegments = Math.max(0, closing.length - 1);
    const cycleReturnDistance = closing.slice(1).reduce((sum, id, i) => sum + scene.graph.edges[closing[i]!]!.find(edge => edge.to === id)!.distanceMm, 0);
    this.playback = { scene, route, cycle, cycleReturnSegments, cycleReturnDistance, loop: Boolean(options.loop), segment: 0, time: 0, elapsed: 0, paused: false, returnSegments };
    this.options.controls.enabled = false;
    this.state = { ...this.state, phase: "playing", message: returnSegments ? "Returning to the captured start via guarded graph edges." : "Following the selected policy path. Escape or drag to take control.", segment: 0, segments: route.length - 1, elapsedSeconds: 0, returnSegments, returnDistanceMm, blockedMoves: 0, port: scene.port, loop: Boolean(options.loop), lap: 1, path: route.map(id => [...scene.graph.nodes[id]!.pose.position]), targetLabel: scene.goal?.label ?? null };
    this.publish();
  }
  tick(deltaSeconds: number): boolean {
    const run = this.playback; if (!run || run.paused) return false;
    if (run.scene.revision !== this.revision) { this.invalidate("Scene changed; camera path stopped."); return false; }
    if (run.segment >= run.route.length - 1) {
      if (!run.loop) { this.playback = null; this.options.controls.enabled = true; this.state.phase = "complete"; this.state.message = run.scene.goal ? `Camera at ${run.scene.goal.label} inspection view. Manual controls are available.` : "Camera inspection path complete. Manual controls are available."; this.publish(); return false; }
      run.route = run.cycle; run.segment = 0; run.time = 0; run.returnSegments = run.cycleReturnSegments;
      this.state.lap++; this.state.segment = 0; this.state.segments = run.route.length - 1;
      this.state.returnSegments = run.returnSegments; this.state.returnDistanceMm = run.cycleReturnDistance;
      this.state.path = run.route.map(id => [...run.scene.graph.nodes[id]!.pose.position]);
      this.state.message = run.returnSegments ? "Returning to the captured start via guarded graph edges." : "Following the selected policy path. Escape or drag to take control.";
    }
    const a = run.scene.graph.nodes[run.route[run.segment]!]!.pose, b = run.scene.graph.nodes[run.route[run.segment + 1]!]!.pose;
    const angle = new THREE.Vector3(...a.direction).angleTo(new THREE.Vector3(...b.direction));
    const arcBound = Math.abs(b.insertionMm - a.insertionMm) + Math.max(a.insertionMm, b.insertionMm) * angle;
    // Quintic easing has zero velocity AND acceleration at each endpoint.
    // Its maximum derivative is 1.875: include it to retain the speed caps.
    const duration = 1.875 * Math.max(arcBound / 24, angle / THREE.MathUtils.degToRad(18), .35);
    const dt = Math.min(.05, Math.max(0, deltaSeconds)); run.time += dt; run.elapsed += dt;
    const t = Math.min(1, run.time / duration), eased = t * t * t * (10 - 15 * t + 6 * t * t), pose = interpolateScopePose(a, b, run.scene.port, eased);
    const previous = this.options.camera.position.clone(), next = new THREE.Vector3(...pose.position);
    const workspace = new THREE.Box3(new THREE.Vector3().fromArray(run.scene.workspace.min), new THREE.Vector3().fromArray(run.scene.workspace.max));
    const hit = this.options.guard.move(previous, next, workspace, NAVIGATION_CLEARANCE_MM + .01);
    if (hit.blocked || hit.position.distanceTo(next) > .001) {
      this.playback = null; this.options.controls.enabled = true; this.state.phase = "blocked"; this.state.blockedMoves++; this.state.message = `Camera stopped before ${hit.blockedBy ?? "a tissue surface"}. Recapture the map.`; this.publish(); return false;
    }
    this.options.camera.position.copy(next); this.options.camera.up.fromArray(pose.up);
    if (run.scene.lightIntensities) this.options.setIntensity?.(THREE.MathUtils.lerp(run.scene.lightIntensities[run.route[run.segment]!]!, run.scene.lightIntensities[run.route[run.segment + 1]!]!, eased));
    this.options.controls.target.copy(next).addScaledVector(new THREE.Vector3(...pose.direction), 40); this.options.camera.lookAt(this.options.controls.target);
    this.options.camera.fov = run.scene.fov; this.options.camera.updateProjectionMatrix();
    this.state.elapsedSeconds = run.elapsed; this.state.segment = run.segment;
    if (t === 1) { run.segment++; run.time = 0; this.state.segment = run.segment; if (run.segment === run.returnSegments) this.state.message = "Following the selected policy path. Escape or drag to take control."; }
    this.options.changed(); this.publish(false); return true;
  }
  dispose() { this.stop("Camera planner closed."); }
}
