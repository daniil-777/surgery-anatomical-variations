import { CameraPlannerScene, type CameraTrainingScene, type CameraPlannerState } from "./cameraPlannerScene";
import { applyVirtaMedVessels } from "./virtaMedVesselNetwork";
import { loadOperativeAppearance, type OperativeAppearance } from "./operativeAppearance";
import { LaparoscopeLighting } from "./laparoscopeLighting";
import { LaparoscopeOptics } from "./laparoscopeOptics";
import { VIRTAMED_SURFACE_VERSION } from "./virtaMedMaterials";
import { buildVirtaMedInterfaces, interfaceSnapshot, reconcileInterfaceNormals, type InterfaceGraph } from "./virtaMedInterfaces";
import { loadVirtaMedAsset } from "./virtaMedAsset";
import { sampleVirtaMedVariation, warpVirtaMedPositions, type VirtaMedVariation } from "./virtaMedScene";
import { loadVirtaMedTiles, disposeVirtaMedTiles, makeVirtaMedMaterial, type VirtaMedTiles } from "./virtaMedMaterials";
import { loadImportedVariationSystem, type ImportedVariationSystem, type ImportedVariationRecipe } from "./imports/variations";
import { pnSubdivideGeometry, computeAngleWeightedNormals, fairSurfaceConcavityOutliers } from "./imports/laparoscopicScene";
import { createOperativeEnvelope, operativeEntry, type OperativeRegion } from "./operativeView";
import { reportReady } from "./api";
import { FatSceneLayerView, type FatSceneOptions } from "./fat/sceneLayerView";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import * as THREE from "three";
import { registerSceneRecordingSource } from "./sceneRecordingSource";
import { installScenePhotoDetail, photoDetailFor, SCENE_TILE_ORGAN } from "./photoDetail";
import type { ReferenceColor } from "./atlasMaterial";
import type { WholeBodyColorPlan } from "./wholeBodyColor";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { updateSceneBounds, updateSceneNormals } from "./sceneSurfaceUpdate";
import { VIRTAMED_TISSUE_RESPONSE } from "./sceneTissueResponse";
import { VIRTAMED_AUTHORED_PHYSICS_JOINTS } from "./virtaMedPhysicsJoints";
import { WholeScenePhysics, type LearnedSceneMaterials, type ScenePhysicsBinding } from "./wholeScenePhysics";
import { WholeSceneTools, type WholeSceneToolMode, type WholeSceneToolState } from "./wholeSceneTools";
import { createWholeSceneTissueVolume, makeWholeSceneTissueMaterial, makeWholeSceneDepthMaterial, WHOLE_SCENE_MATERIAL_VERSION } from "./wholeSceneMaterials";
import {
  sceneBufferSignature, warpScenePositions, WHOLE_SCENE_CATEGORIES,
  type WholeSceneCategory, type WholeSceneVariation, type WholeSceneView,
} from "./wholeSceneModel";
import {
  SceneNavigationGuard, currentSceneBounds, navigationAngles, navigationDirection, navigationStep,
  NAVIGATION_CLEARANCE_MM, NAVIGATION_SPEED_MM_S,
  type WholeSceneNavigationDirection, type WholeSceneNavigationState,
} from "./wholeSceneNavigation";

export type { WholeSceneView } from "./wholeSceneModel";
export type { WholeSceneToolMode, WholeSceneToolState } from "./wholeSceneTools";
export type { WholeSceneNavigationDirection, WholeSceneNavigationState } from "./wholeSceneNavigation";
export interface WholeSceneOrgan {
  id: string; label: string; category: WholeSceneCategory; color: string;
}
export interface WholeSceneStats {
  organs: WholeSceneOrgan[]; triangles: number; vertices: number;
  bounds: { min: number[]; max: number[] };
}
export interface WholeSceneViewportHandle {
  captureCameraMap: (targets: string[], signal?: AbortSignal) => Promise<CameraTrainingScene>;
  playCameraPath: (scene: CameraTrainingScene, route: number[]) => void;
  stopCameraPath: () => void;
  pauseCameraPath: () => void;
  videoView: () => void;
  fit: () => void;
  focusOrgan: (id: string) => void;
  view: (preset: WholeSceneView) => void;
  screenshot: () => string;
  recordTour: (durationSeconds?: number) => Promise<Blob>;
  recordInteraction: (durationSeconds?: number) => Promise<Blob>;
  releaseTool: () => void;
  adjustToolDepth: (deltaMm: number) => void;
  engageSelectedTool: () => void;
  stopRecording: () => void;
  pulsePhysics: () => void;
  resetPhysics: () => void;
  captureMetadata: () => Record<string, unknown>;
  enterExploration: (region?: OperativeRegion) => void;
  exitExploration: (keepCamera?: boolean) => void;
  resetExploration: () => void;
  moveExploration: (direction: WholeSceneNavigationDirection, distanceMm?: number) => void;
  lookExploration: (yawDeltaDeg: number, pitchDeltaDeg: number) => void;
}
export interface WholeSceneViewportProps {
  onCameraPlannerChange?: (state: CameraPlannerState) => void;
  sourceScene?: "atlas" | "virtamed";
  whiteSurface?: boolean;
  operativeResidue?: number;
  disease?: string;
  textRecipe?: ImportedVariationRecipe | null;
  fatOptions?: FatSceneOptions;
  onFatStatus?: (status: string) => void;
  referenceColors?: Record<string, ReferenceColor>;
  bodyReferencePlan?: WholeBodyColorPlan | null;
  variation: WholeSceneVariation;
  /** Photo-derived detail over the tissues that have a bundled tile (photoDetail.ts), 0 = off. */
  photoDetail?: number;
  visibility: Partial<Record<WholeSceneCategory, boolean>>;
  hiddenOrgans?: string[];
  breathing: boolean;
  autoRotate: boolean;
  physicsMaterials?: LearnedSceneMaterials | null;
  physicsRunning?: boolean;
  toolMode?: WholeSceneToolMode;
  toolRadiusMm?: number;
  toolDepthMm?: number;
  continuousPush?: boolean;
  pushSpeedMmS?: number;
  onToolStatus?: (state: WholeSceneToolState) => void;
  selectedOrgan?: string | null;
  onSelect?: (id: string | null) => void;
  onReady?: (stats: WholeSceneStats) => void;
  onError: (message: string) => void;
  onRecordingChange?: (active: boolean) => void;
  onNavigationChange?: (state: WholeSceneNavigationState) => void;
}
interface Manifest { organs: WholeSceneOrgan[]; [key: string]: unknown }
interface Part {
  info: WholeSceneOrgan; mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>;
  rest: Float32Array; variant: Float32Array; binding: ScenePhysicsBinding | null; restBounds: { min: number[]; max: number[] };
  geometrySignature: string; materialSignature: string;
}
interface Runtime {
  captureCameraMap: (targets: string[], signal?: AbortSignal) => Promise<CameraTrainingScene>;
  playCameraPath: (scene: CameraTrainingScene, route: number[]) => void;
  stopCameraPath: () => void;
  pauseCameraPath: () => void;
  videoView: () => void;
  fit: () => void; focusOrgan: (id: string) => void; view: (preset: WholeSceneView) => void;
  screenshot: () => string; captureMetadata: () => Record<string, unknown>;
  recordTour: (durationSeconds?: number) => Promise<Blob>; stopRecording: () => void;
  recordInteraction: (durationSeconds?: number) => Promise<Blob>;
  releaseTool: () => void; adjustToolDepth: (deltaMm: number) => void; engageSelectedTool: () => void; syncToolOptions: () => void;
  applyVariation: () => void; applyVisibility: () => void; applySelection: () => void;
  applyReferenceColors: () => void;
  invalidateCameraMap: (reason: string) => void;
  applyFat: () => void;
  applyPhysics: () => void; pulsePhysics: () => void; resetPhysics: () => void;
  enterExploration: (region?: OperativeRegion) => void; exitExploration: (keepCamera?: boolean) => void; resetExploration: () => void;
  moveExploration: (direction: WholeSceneNavigationDirection, distanceMm?: number) => void;
  lookExploration: (yawDeltaDeg: number, pitchDeltaDeg: number) => void;
}
const boxData = (box: THREE.Box3) => ({ min: box.min.toArray(), max: box.max.toArray() });

/** The coarse stomach surface has very unequal triangle areas. Weighting each
 * incident face by its corner angle avoids letting its longest triangles flatten
 * the shading; source positions and connectivity remain byte-for-byte unchanged. */
function updateTissueNormals(geometry: THREE.BufferGeometry, id: string) {
  updateSceneNormals(geometry, /^(liver|hepatocystic-fat|stomach|gallbladder|spleen|duodenum|pancreas|.*kidney|colon|small-intestine)$/.test(id));
}
function disposeObject(root: THREE.Object3D) {
  root.traverse(object => {
    if (object instanceof THREE.Mesh) {
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach(material => material.dispose());
      object.customDepthMaterial?.dispose();
    }
  });
}

/** Full atlas assembly remains registered in one millimetre coordinate frame. */
export const WholeSceneViewport = forwardRef<WholeSceneViewportHandle, WholeSceneViewportProps>(function WholeSceneViewport(props, ref) {
  const photoMaterials = useRef<{ material: THREE.MeshPhysicalMaterial; organ: string }[]>([]);
  const photoStrength = props.photoDetail ?? 0;
  const attachPhoto = (material: THREE.Material, organId: string) => {
    const tileOrgan = SCENE_TILE_ORGAN[organId];
    if (!tileOrgan || !(material instanceof THREE.MeshPhysicalMaterial)) return;
    const entry = { material, organ: tileOrgan };
    photoMaterials.current.push(entry);
    material.addEventListener("dispose", () => { photoMaterials.current = photoMaterials.current.filter((e) => e !== entry); });
    if (photoStrength > 0) void photoDetailFor(tileOrgan).then((detail) => { if (photoMaterials.current.includes(entry)) { installScenePhotoDetail(material, detail, photoStrength); runtime.current?.invalidateCameraMap("Photographic tissue detail changed. Capture a fresh camera map."); } }).catch(() => {});
  };
  useEffect(() => {
    let live = true;
    runtime.current?.invalidateCameraMap("Photographic tissue detail changed. Capture a fresh camera map.");
    for (const entry of photoMaterials.current) {
      if (photoStrength <= 0) { installScenePhotoDetail(entry.material, null, 0); continue; }
      void photoDetailFor(entry.organ).then((detail) => { if (live && photoMaterials.current.includes(entry)) { installScenePhotoDetail(entry.material, detail, photoStrength); runtime.current?.invalidateCameraMap("Photographic tissue detail loaded. Capture a fresh camera map."); } }).catch(() => {});
    }
    return () => { live = false; };
  }, [photoStrength]);
  const host = useRef<HTMLDivElement>(null);
  const runtime = useRef<Runtime | null>(null);
  const latest = useRef(props);
  latest.current = props;
  useImperativeHandle(ref, () => ({
    fit: () => runtime.current?.fit(), focusOrgan: id => runtime.current?.focusOrgan(id), view: preset => runtime.current?.view(preset),
    videoView: () => runtime.current?.videoView(),
    captureCameraMap: (targets,signal) => runtime.current ? runtime.current.captureCameraMap(targets,signal) : Promise.reject(new Error("The scene is still loading.")),
    playCameraPath: (scene,route) => runtime.current?.playCameraPath(scene,route),
    stopCameraPath: () => runtime.current?.stopCameraPath(),
    pauseCameraPath: () => runtime.current?.pauseCameraPath(),
    screenshot: () => runtime.current?.screenshot() ?? "",
    captureMetadata: () => runtime.current?.captureMetadata() ?? {},
    recordTour: seconds => runtime.current ? runtime.current.recordTour(seconds) : Promise.reject(new Error("The anatomy is still loading.")),
    recordInteraction: seconds => runtime.current ? runtime.current.recordInteraction(seconds) : Promise.reject(new Error("The anatomy is still loading.")),
    releaseTool: () => runtime.current?.releaseTool(),
    adjustToolDepth: delta => runtime.current?.adjustToolDepth(delta),
    engageSelectedTool: () => runtime.current?.engageSelectedTool(),
    stopRecording: () => runtime.current?.stopRecording(),
    pulsePhysics: () => runtime.current?.pulsePhysics(),
    resetPhysics: () => runtime.current?.resetPhysics(),
    enterExploration: region => runtime.current?.enterExploration(region),
    exitExploration: keepCamera => runtime.current?.exitExploration(keepCamera),
    resetExploration: () => runtime.current?.resetExploration(),
    moveExploration: (direction, distanceMm) => runtime.current?.moveExploration(direction, distanceMm),
    lookExploration: (yaw, pitch) => runtime.current?.lookExploration(yaw, pitch),
  }), []);
  useEffect(() => {
    const isVirtaMed = props.sourceScene === "virtamed";
    let vmTiles: VirtaMedTiles | null = null;
    let vmOperative: OperativeAppearance | null = null;
    let vmSystem: ImportedVariationSystem | null = null;
    let vmSample: VirtaMedVariation | null = null;
    let vmInterfaces: InterfaceGraph | null = null;
    let vmAsset: { sha256: string; bytes: number; version: string } | null = null;
    let operativeCamera = false;
    let cameraPlanner: CameraPlannerScene | null = null;
    const element = host.current;
    if (!element) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: "high-performance" });
    } catch (error) {
      latest.current.onError(`The scene viewer could not start: ${error instanceof Error ? error.message : "WebGL2 unavailable"}`);
      return;
    }
    let alive = true, frame = 0, renderedFrames = 0, animationFrames = 0, ready = false;
    let renderPending = true, sceneRevision = 1, renderedRevision = 0, snapshotAfterDraw = false, updatingControls = false;
    const abort = new AbortController();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.88;
    renderer.shadowMap.enabled = new URLSearchParams(window.location.search).get("sceneShadows") !== "off";
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.shadowMap.autoUpdate = false; renderer.shadowMap.needsUpdate = true;
    renderer.setClearColor(0x091016, 0);
    const canvas = renderer.domElement;
    const orbitDescription = "Full torso anatomical scene. Camera mode: drag to orbit and scroll to zoom. Push or Grasp mode: click a tissue surface to attach, move the pointer, and click again to release; or hold and drag. Use the wheel for depth. Keyboard: Enter engages or releases, arrows move, Page Up and Page Down adjust depth, Escape releases.";
    canvas.setAttribute("aria-label", orbitDescription);
    canvas.setAttribute("role", "img");
    element.appendChild(canvas);
    const scene = new THREE.Scene(), assembly = new THREE.Group();
    scene.add(assembly);
    const camera = new THREE.PerspectiveCamera(31, 1, 0.1, 10000);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true; controls.dampingFactor = 0.085;
    controls.screenSpacePanning = true; controls.autoRotateSpeed = 0.9;
    const invalidate = (shadows = false) => { renderPending = true; sceneRevision++; if (shadows) renderer.shadowMap.needsUpdate = true; };
    const draw = () => {
      if (cameraPlanner?.capturing) return;
      if (laparoscope.update(camera, exploring || operativeCamera ? inspectionIntensity : 0)) renderer.shadowMap.needsUpdate = true;
      if (fatLamp.visible && fatLamp.intensity > 0) {
        if (!fatLamp.position.equals(camera.position) || !fatLamp.target.position.equals(controls.target)) renderer.shadowMap.needsUpdate = true;
        fatLamp.position.copy(camera.position); fatLamp.target.position.copy(controls.target);
      }
      if (cameraOptics && (exploring || operativeCamera)) cameraOptics.render(scene, camera); else renderer.render(scene, camera); renderedFrames++; renderedRevision = sceneRevision; renderPending = false;
      if (snapshotAfterDraw) { snapshotAfterDraw = false; snapshot(); }
    };
    const room = new RoomEnvironment(), pmrem = new THREE.PMREMGenerator(renderer);
    const environment = pmrem.fromScene(room, 0.06);
    room.dispose(); pmrem.dispose(); scene.environment = environment.texture;
    scene.environmentIntensity = .4;
    const tissueVolume = createWholeSceneTissueVolume();
    const bowelFrontSide = new URLSearchParams(window.location.search).get("sceneBowelSides") === "front";
    const hemisphere = new THREE.HemisphereLight(0xe3e6ef, 0x4b3e3c, 0.36); scene.add(hemisphere);
    const key = new THREE.DirectionalLight(0xffefe5, 1.9);
    key.position.set(-490, 470, 680); key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048); key.shadow.normalBias = .2; key.shadow.bias = -.00008;
    key.shadow.radius = 2; key.shadow.camera.near = 10; key.shadow.camera.far = 2000;
    scene.add(key, key.target);
    const fill = new THREE.DirectionalLight(0xdce7f5, 0.3); fill.position.set(500, 180, 380); scene.add(fill);
    const rim = new THREE.DirectionalLight(0xe3c8c2, 0.75); rim.position.set(220, 320, -650); scene.add(rim);
    const fatLamp = new THREE.SpotLight(0xfff5eb, 250000, 0, .72, .55, 2);
    fatLamp.visible = false; fatLamp.castShadow = true;
    fatLamp.shadow.mapSize.set(2048, 2048); fatLamp.shadow.camera.near = 2; fatLamp.shadow.camera.far = 4000;
    fatLamp.shadow.normalBias = .25; fatLamp.shadow.bias = -.00008;
    scene.add(fatLamp, fatLamp.target);
    const updateFatLighting = () => {
      const mode = latest.current.fatOptions?.enabled ? latest.current.fatOptions.lighting ?? "studio" : "studio";
      // Native PNG/video captures should retain the same opaque backdrop as the
      // adipose inspection viewport, rather than silently encoding black alpha.
      renderer.setClearColor(latest.current.fatOptions?.enabled ? 0x111b20 : 0x091016, latest.current.fatOptions?.enabled ? 1 : 0);
      const surgical = exploring || operativeCamera || mode === "surgical", grazing = !exploring && mode === "grazing";
      // Keep light counts stable while switching inspection modes. Toggling
      // visibility forced all organ shaders to compile again on the first click.
      fatLamp.visible = Boolean(latest.current.fatOptions?.enabled);
      fatLamp.intensity = surgical && !exploring ? 250000 : 0;
      key.visible = true; key.intensity = surgical ? 0 : grazing ? 2.5 : 1.9;
      key.position.set(grazing ? -600 : -490, grazing ? 40 : 470, grazing ? 100 : 680);
      fill.intensity = surgical ? .03 : grazing ? .12 : .3;
      rim.intensity = surgical ? 0 : grazing ? .12 : .75;
      hemisphere.intensity = surgical ? .06 : grazing ? .12 : .36;
      scene.environmentIntensity = exploring ? .012 : surgical ? .04 : grazing ? .14 : .4;
      if (exploring) renderer.setClearColor(0x100807, 1);
      invalidate(true);
    };
    const parts: Part[] = [];
    const breath = { value: 0 };
    let physics: WholeScenePhysics | null = null, physicsSteps = 0, physicsFailed = false;
    let geometryUploads = 0, surfaceCpuMs = 0, solverCpuMs = 0;
    let wasPhysicsMoving = false;
    const fatLayers = new FatSceneLayerView(assembly, () => parts.map(part => ({ id: part.info.id, mesh: part.mesh, rest: part.rest })), latest.current.variation, () => { invalidate(true); snapshotAfterDraw = true; latest.current.onFatStatus?.(fatLayers.snapshot().status); }, message => latest.current.onError(message));
    const applyFat = () => {
      cameraPlanner?.invalidate("Surrounding tissue changed. Capture a fresh camera map."); updateFatLighting(); if (parts.length) fatLayers.configure(latest.current.fatOptions ?? { enabled: false, seed: 42, thicknessMm: 5, omentum: true, perirenal: true }); };
    let manifest: Manifest | null = null, fitRadius = 400;
    let currentView: WholeSceneView | "orbit" = "front";
    let focusedOrgan: string | null = null;
    let cameraTransition: { started: number; fromPosition: THREE.Vector3; toPosition: THREE.Vector3; fromTarget: THREE.Vector3; toTarget: THREE.Vector3 } | null = null;
    let lastImageCapture: { width: number; height: number; materialVersion: string } | null = null;
    const center = new THREE.Vector3(), bounds = new THREE.Box3();
    camera.position.set(0, 0, 1500);
    let exploring = false, navigationYaw = 0, navigationPitch = 0;
    let navigationBlockedBy: string | null = null, navigationMessage = "Orbit the atlas or start between-organ inspection.";
    let savedOrbit: { position: THREE.Vector3; target: THREE.Vector3; up: THREE.Vector3; fov: number; near: number; minDistance: number; maxDistance: number; view: WholeSceneView | "orbit"; focusedOrgan: string | null; inspectionIntensity: number } | null = null;
    let entryPose: { position: THREE.Vector3; yaw: number; pitch: number } | null = null;
    let lookPointer: { id: number; x: number; y: number } | null = null;
    const navigationKeys = new Set<string>();
    const atlasSurfaces = () => parts.map(part => ({ id: part.info.id, visible: part.mesh.visible, geometry: part.mesh.geometry }));
    let operativeEnvelope: ReturnType<typeof createOperativeEnvelope> = null;
    const navigationGuard = new SceneNavigationGuard(() => [...atlasSurfaces(), ...fatLayers.navigationSurfaces(), ...(operativeEnvelope && exploring ? [{id: operativeEnvelope.mesh.name, visible: true, geometry: operativeEnvelope.mesh.geometry}] : [])]);
    let inspectionIntensity = 0;
    const inspectionLight = new THREE.SpotLight(0xfff0e5, 0, 1000, 1.05, .8, 2);
    const laparoscope = new LaparoscopeLighting(scene, inspectionLight);
    const cameraOptics = renderer.extensions.has("EXT_color_buffer_float") ? new LaparoscopeOptics(renderer) : null;
    const navigationSnapshot = (): WholeSceneNavigationState => ({
      mode: exploring ? "explore" : "orbit", ready, blocked: navigationBlockedBy !== null, blockedBy: navigationBlockedBy,
      positionMm: camera.position.toArray(), direction: camera.getWorldDirection(new THREE.Vector3()).toArray(),
      clearanceMm: NAVIGATION_CLEARANCE_MM, speedMmS: NAVIGATION_SPEED_MM_S, message: navigationMessage,
    });
    let lastNavigationPublish = -Infinity, navigationPublishPending = false;
    const publishNavigation = (force = true) => {
      const now = performance.now();
      if (alive && (force || now - lastNavigationPublish >= 100)) {
        lastNavigationPublish = now; navigationPublishPending = false; latest.current.onNavigationChange?.(navigationSnapshot());
      } else navigationPublishPending = true;
    };
    const releaseLookPointer = () => {
      const pointer = lookPointer; lookPointer = null;
      if (pointer && canvas.hasPointerCapture(pointer.id)) canvas.releasePointerCapture(pointer.id);
    };
    let recorder: MediaRecorder | null = null;
    let recording: { kind: "tour" | "interaction"; started: number; duration: number; angle: number; distance: number; elevation: number } | null = null;
    let recordingTimer: ReturnType<typeof setTimeout> | null = null;
    let recordingStream: MediaStream | null = null;
    const nativeRecording = registerSceneRecordingSource({ renderer, camera, host: element, label: "Whole anatomy scene", draw, available: () => ready && !recorder && !cameraPlanner?.busy });
    let lastSnapshot = 0;
    const tools = new WholeSceneTools({ scene, camera, controls, canvas, parts: () => parts, physics: () => physics,
      options: () => ({ mode: exploring ? "orbit" : latest.current.toolMode ?? "orbit", radius: latest.current.toolRadiusMm ?? 6, depth: latest.current.toolDepthMm ?? 2,
        continuousPush: latest.current.continuousPush ?? false, pushSpeedMmS: latest.current.pushSpeedMmS ?? 3,
        running: !exploring && Boolean(latest.current.physicsRunning) && !physicsFailed, ready: ready && !physicsFailed, selected: latest.current.selectedOrgan ?? null, recording: recording?.kind ?? null }),
      invalidate, select: id => latest.current.onSelect?.(id), status: state => { if (alive) latest.current.onToolStatus?.(state); },
    });
    const captureMetadata = (): Record<string, unknown> => ({
      sourceScene: isVirtaMed ? "virtamed" : "atlas", surfaceMode: isVirtaMed ? latest.current.whiteSurface ? "white" : "learned-tissue" : "atlas",
      videoReconstruction: isVirtaMed ? { asset: vmAsset, source: "Full.mp4 00:08–00:15", visibleFieldOnly: true, hiddenSurfacesInferred: true, scale: "assumed mm", recipe: vmSample?.recipe.provenance, organRecipes: Object.fromEntries(Object.entries(vmSample?.recipes ?? {}).map(([id,recipe])=>[id,recipe.provenance])), disease: vmSample?.disease, supportedWall: "closed inward lining; supported local deformation", interfaces: interfaceSnapshot(vmInterfaces,vmSample), textures: Object.values(vmTiles ?? {}).map(t => ({bundle:t.bundle,sha256:t.sha256,resolution:512})) } : null,
      version: "bodyparts3d-whole-scene-v2", ready, renderedFrames, animationFrames, wall_time_ms: performance.now(),
      ...latest.current.variation,
      referenceColors: latest.current.referenceColors ?? {},
      bodyReferencePlan: latest.current.bodyReferencePlan ?? null,
      fat: fatLayers.snapshot(),
      coordinateSystem: "+X patient left; +Y superior; +Z anterior; millimetres",
      atlasBounds: boxData(bounds),
      rendering: { mode: "on-demand", geometryUploads, surfaceCpuMs, solverCpuMs, surfaceTargetHz: isVirtaMed ? 60 : 20, renderPending, sceneRevision, renderedRevision, cameraTransition: Boolean(cameraTransition), materialVersion: isVirtaMed ? VIRTAMED_SURFACE_VERSION : WHOLE_SCENE_MATERIAL_VERSION, laparoscope: laparoscope.snapshot(), optics: cameraOptics ? {...cameraOptics.snapshot(),active:exploring||operativeCamera} : {hdr:false,reason:"floating-point render targets unavailable"}, tissueCoordinates: "undeformed atlas rest millimetres", tissueVolumeSize: 64, bowelSidedness: bowelFrontSide ? "front" : "double", stomachNormalWeighting: "corner-angle", environmentIntensity: scene.environmentIntensity, lastImageCapture, lights: { fatCamera: { enabled: fatLamp.visible && fatLamp.intensity > 0, intensity: fatLamp.intensity, position: fatLamp.position.toArray() }, key: { intensity: key.intensity, position: key.position.toArray() }, fill: { intensity: fill.intensity, position: fill.position.toArray() }, rim: { intensity: rim.intensity, position: rim.position.toArray() } }, shadows: renderer.shadowMap.enabled, shadowMapSize: 2048, shadowNormalBiasMm: key.shadow.normalBias, shadowDepthBias: key.shadow.bias, exposure: renderer.toneMappingExposure },
      registration: isVirtaMed ? "Authored video-field reconstruction in shared assumed millimetres. Broad learned controls and localized phenotype fields are shared across neighboring structures." : "BodyParts3D structures retain source registration; HRA heart and lung surfaces are fitted to atlas bounds (see manifest). Every structure then uses one shared invertible variation map.",
      sourceConnections: isVirtaMed ? "Registered gallbladder–duct ring, gallbladder–liver membrane, cranial sheet roots and internal fatty bridge. Coincident attachment coordinates share the disease and physics maps; concealed anatomy is inferred." : "Atlas-derived ducts and vessels; coincident points remain coincident. Source endpoint attachment is not inferred or certified.",
      cameraPlanner: cameraPlanner?.snapshot() ?? null,
      camera: { view: currentView, focusedOrgan, position: camera.position.toArray(), target: controls.target.toArray(), up: camera.up.toArray(), fov: camera.fov, aspect: camera.aspect, navigation: navigationSnapshot() },
      inspection: { surfaceScope: "visible atlas triangles, generated fat and illustrative peritoneal enclosure; no reconstructed organ lumens", radiusMm: NAVIGATION_CLEARANCE_MM,
        cameraLight: { enabled: exploring || operativeCamera, intensity: inspectionIntensity, positionMm: inspectionLight.position.toArray(), targetMm: inspectionLight.target.position.toArray() } },
      motion: { breathing: latest.current.breathing, phase: breath.value, autoRotate: latest.current.autoRotate, recording: Boolean(recording), recordingKind: recording?.kind ?? null },
      tools: tools.snapshot(),
      physics: physics ? { ...physics.snapshot(), running: Boolean(latest.current.physicsRunning) && !physicsFailed,
        renderedSamples: parts.map(part => {
          const positions = part.mesh.geometry.getAttribute("position");
          const indices = [0, Math.floor(positions.count / 4), Math.floor(positions.count / 2), Math.floor(positions.count * 3 / 4), positions.count - 1];
          return { id: part.info.id, positions: indices.map(i => [positions.getX(i), positions.getY(i), positions.getZ(i)]),
            maxSampleDisplacementMm: Math.max(...indices.map(i => Math.hypot(positions.getX(i) - part.variant[3*i]!, positions.getY(i) - part.variant[3*i+1]!, positions.getZ(i) - part.variant[3*i+2]!))) };
        }),
      } : null,
      organs: parts.map(part => ({ ...part.info, visible: part.mesh.visible, geometrySignature: part.geometrySignature, materialSignature: part.materialSignature, appearance: part.mesh.material.userData.appearance,
        vertices: part.rest.length / 3, triangles: (part.mesh.geometry.index?.count ?? part.rest.length / 3) / 3,
        restBounds: part.restBounds, bounds: boxData(part.mesh.geometry.boundingBox!), ambientOcclusion: part.mesh.userData.ambientOcclusion,
      })),
    });
    // Read-only, on-demand diagnostics avoid DOM publication latency during video review.
    const diagnostics = window as Window & { __visceraSceneSnapshot?: () => Record<string, unknown> };
    diagnostics.__visceraSceneSnapshot = captureMetadata;
    const snapshot = () => {
      if (!alive) return;
      element.dataset.sceneReady = String(ready);
      element.dataset.sceneSnapshot = JSON.stringify(captureMetadata());
    };
    const applyNavigationPose = () => {
      const forward = navigationDirection(navigationYaw, navigationPitch);
      camera.up.set(0, 1, 0); controls.target.copy(camera.position).addScaledVector(forward, 20); camera.lookAt(controls.target);
      const workingDistance = THREE.MathUtils.clamp(navigationGuard.rayDistance(camera.position, forward, 120), 22, 100);
      inspectionIntensity = workingDistance * workingDistance * 3.4;
      currentView = "orbit"; invalidate(); snapshotAfterDraw = true;
    };
    const moveNavigation = (delta: THREE.Vector3) => {
      if (!exploring || !delta.lengthSq()) return;
      const limits = bounds.clone().expandByScalar(fitRadius * 14);
      const result = navigationGuard.move(camera.position, camera.position.clone().add(delta), limits);
      camera.position.copy(result.position); navigationBlockedBy = result.blockedBy;
      navigationMessage = result.blocked ? `Camera stopped before ${result.blockedBy}. Turn, retreat, or hide a structure to inspect beyond it.` : "Between-organ inspection. Visible tissue surfaces are guarded; organ interiors are not reconstructed.";
      applyNavigationPose(); publishNavigation(false);
    };
    const lookExploration = (yawDeltaDeg: number, pitchDeltaDeg: number) => {
      if (!exploring || ![yawDeltaDeg, pitchDeltaDeg].every(Number.isFinite)) return;
      navigationYaw += THREE.MathUtils.degToRad(THREE.MathUtils.clamp(yawDeltaDeg, -180, 180));
      navigationPitch = THREE.MathUtils.clamp(navigationPitch + THREE.MathUtils.degToRad(THREE.MathUtils.clamp(pitchDeltaDeg, -180, 180)), -Math.PI / 2 + .01, Math.PI / 2 - .01);
      applyNavigationPose(); publishNavigation(false);
    };
    const moveExploration = (direction: WholeSceneNavigationDirection, distanceMm = 10) => {
      if (!exploring) return;
      moveNavigation(navigationStep(direction, navigationDirection(navigationYaw, navigationPitch), Math.min(100, Math.max(0, distanceMm))));
    };
    const exitExploration = (keepCamera = false) => {
      if (!exploring) return;
      exploring = false; navigationKeys.clear(); releaseLookPointer();
      // A retained interior camera needs its saved light power, not the distant video-view preset.
      if (!keepCamera) inspectionIntensity = operativeCamera ? savedOrbit?.inspectionIntensity ?? 155000 : 0;
      operativeEnvelope?.dispose(); operativeEnvelope = null; navigationGuard.invalidate(); updateFatLighting();
      canvas.setAttribute("aria-label", orbitDescription);
      if (savedOrbit && !keepCamera) {
        camera.position.copy(savedOrbit.position); camera.up.copy(savedOrbit.up); controls.target.copy(savedOrbit.target);
        camera.fov = savedOrbit.fov; camera.near = savedOrbit.near; camera.updateProjectionMatrix();
        currentView = savedOrbit.view; focusedOrgan = savedOrbit.focusedOrgan;
        controls.minDistance = savedOrbit.minDistance; controls.maxDistance = savedOrbit.maxDistance;
        const damping = controls.enableDamping; controls.enableDamping = false; controls.update(0); controls.enableDamping = damping;
      }
      if (keepCamera) {
        operativeCamera = true; currentView = "orbit"; focusedOrgan = null;
        controls.minDistance = 1; controls.maxDistance = fitRadius * 12;
        const damping = controls.enableDamping; controls.enableDamping = false; controls.update(0); controls.enableDamping = damping;
        updateFatLighting();
      }
      savedOrbit = null; entryPose = null; navigationBlockedBy = null; navigationMessage = keepCamera ? "Inspection camera retained for instruments." : "Returned to the saved orbit view.";
      tools.syncOptions(); invalidate(); snapshotAfterDraw = true; publishNavigation();
    };
    const resetExploration = () => {
      if (cameraPlanner?.busy) cameraPlanner.stop("Camera view changed; planner stopped.");
      if (!exploring || !entryPose) return;
      navigationKeys.clear(); camera.position.copy(entryPose.position); navigationYaw = entryPose.yaw; navigationPitch = entryPose.pitch;
      navigationBlockedBy = null; navigationMessage = "Inspection entry pose restored.";
      applyNavigationPose(); publishNavigation();
    };
    const enterExploration = (region?: OperativeRegion) => {
      if (cameraPlanner?.busy) cameraPlanner.stop("Manual camera inspection selected.");
      if (!ready || recording) return;
      if (exploring) { if (!region) return; exitExploration(); }
      tools.release("Instrument released for between-organ camera inspection."); cameraTransition = null;
      const damping = controls.enableDamping; controls.enableDamping = false; controls.update(0); controls.enableDamping = damping;
      const overlap = navigationGuard.closest(camera.position);
      if (overlap && overlap.distanceMm < NAVIGATION_CLEARANCE_MM) {
        latest.current.onError("The current camera overlaps a visible surface. Fit the whole scene before starting inspection."); return;
      }
      savedOrbit = { position: camera.position.clone(), target: controls.target.clone(), up: camera.up.clone(), fov: camera.fov, near: camera.near, minDistance: controls.minDistance, maxDistance: controls.maxDistance, view: currentView, focusedOrgan, inspectionIntensity };
      const entry = region ? operativeEntry(atlasSurfaces(), region, new SceneNavigationGuard(atlasSurfaces)) : null;
      if (entry) { camera.position.copy(entry.position); camera.lookAt(entry.position.clone().add(entry.forward)); }
      const forward = camera.getWorldDirection(new THREE.Vector3()), angles = navigationAngles(forward);
      navigationYaw = angles.yaw; navigationPitch = angles.pitch; exploring = true; navigationKeys.clear(); focusedOrgan = null;
      camera.fov = 70; camera.near = .1; camera.updateProjectionMatrix();
      operativeEnvelope = isVirtaMed ? null : createOperativeEnvelope(atlasSurfaces());
      if (operativeEnvelope) scene.add(operativeEnvelope.mesh);
      updateFatLighting();
      canvas.setAttribute("aria-label", "Between-organ inspection camera. Drag to look. W and S move forward and back; A and D strafe; Q and E move down and up. Arrow keys look. Escape returns to the saved orbit view. Visible tissue surfaces are guarded, not reconstructed organ lumens.");
      controls.enabled = false; controls.autoRotate = false;
      const maximum = fitRadius * 12, distance = navigationGuard.rayDistance(camera.position, forward, maximum);
      if (!entry && distance < maximum) moveNavigation(forward.multiplyScalar(Math.max(0, distance - 55)));
      entryPose = { position: camera.position.clone(), yaw: navigationYaw, pitch: navigationPitch };
      navigationBlockedBy = null; navigationMessage = "Drag to look; W/S forward/back, A/D strafe, Q/E down/up; arrows look; Escape returns to orbit.";
      applyNavigationPose(); draw(); canvas.focus({ preventScroll: true }); publishNavigation();
    };
    const videoView = () => {
      if (cameraPlanner?.busy) cameraPlanner.stop("Camera view changed; planner stopped.");
      if (!isVirtaMed || !parts.length) return;
      exitExploration(); tools.release(); cameraTransition = null; operativeCamera = true;
      camera.fov = 46; camera.position.set(-4,-32,247); controls.target.set(-4,1,0); camera.up.set(0,1,0);
      camera.near = .1; camera.far = 4000; camera.updateProjectionMatrix(); controls.minDistance=12; controls.maxDistance=1500;
      inspectionIntensity=155000; updateFatLighting();
      controls.update(); invalidate(true); draw(); snapshot();
    };
    const fit = () => {
      if (cameraPlanner?.busy) cameraPlanner.stop("Camera view changed; planner stopped.");
      if (!parts.length) return;
      operativeCamera=false;
      exitExploration();
      tools.release("Instrument released to fit the scene.");
      cameraTransition = null; focusedOrgan = null; invalidate(true);
      currentSceneBounds(parts.map(part => part.mesh.geometry), bounds);
      const sphere = bounds.getBoundingSphere(new THREE.Sphere());
      fitRadius = Math.max(sphere.radius, 1); center.copy(sphere.center);
      key.target.position.copy(center);
      const shadowExtent = fitRadius * 1.12;
      key.shadow.camera.left = -shadowExtent; key.shadow.camera.right = shadowExtent;
      key.shadow.camera.top = shadowExtent; key.shadow.camera.bottom = -shadowExtent;
      key.shadow.camera.far = Math.max(2000, key.position.distanceTo(center) + fitRadius * 2);
      key.shadow.camera.updateProjectionMatrix();
      const direction = camera.position.clone().sub(controls.target).normalize();
      if (!direction.lengthSq()) direction.set(0, 0, 1);
      const vertical = THREE.MathUtils.degToRad(camera.fov / 2);
      const horizontal = Math.atan(Math.tan(vertical) * camera.aspect);
      // Fit the full bounds even when the translucent skeleton is hidden.
      const distance = fitRadius / Math.sin(Math.min(vertical, horizontal)) * 1.04;
      controls.target.copy(center); camera.position.copy(center).addScaledVector(direction, distance);
      camera.near = Math.max(0.05, fitRadius / 5000); camera.far = fitRadius * 80; camera.updateProjectionMatrix();
      controls.minDistance = fitRadius * .25; controls.maxDistance = fitRadius * 12; controls.update(); snapshot();
    };
    const view = (preset: WholeSceneView) => {
      if (cameraPlanner?.busy) cameraPlanner.stop("Manual camera view selected.");
      exitExploration();
      const directions: Record<WholeSceneView, [number, number, number]> = {
        front: [0, 0, 1], back: [0, 0, -1], left: [1, 0, 0], right: [-1, 0, 0], top: [0, 1, 0.0001], bottom: [0, -1, 0.0001], oblique: [.65, .18, 1],
      };
      currentView = preset;
      camera.up.set(0, 1, 0);
      if (focusedOrgan?.startsWith("fat-")) {
        // Preserve the inspected depot when changing angle; the old view action
        // always fitted the torso and made small fat structures disappear.
        // A quick angle click must finish the intended focus, not freeze the
        // partially animated torso pose. This also preserves close framing
        // and camera-light falloff when recording immediately after focusing.
        const destination = cameraTransition?.toTarget ?? controls.target;
        const position = cameraTransition?.toPosition ?? camera.position;
        const distance = position.distanceTo(destination);
        controls.target.copy(destination);
        cameraTransition = null;
        camera.position.copy(controls.target).addScaledVector(new THREE.Vector3(...directions[preset]).normalize(), distance);
        const damping = controls.enableDamping; controls.enableDamping = false; controls.update(0); controls.enableDamping = damping;
        invalidate(true); draw(); snapshot();
      } else {
        camera.position.copy(controls.target).add(new THREE.Vector3(...directions[preset]).multiplyScalar(fitRadius * 4));
        fit(); draw(); snapshot();
      }
    };
    const focusOrgan = (id: string) => {
      if (cameraPlanner?.busy) cameraPlanner.stop("Manual organ focus selected.");
      const part = parts.find(item => item.info.id === id);
      const targetBounds = part?.mesh.geometry.boundingBox ?? fatLayers.bounds(id);
      if (!targetBounds || recording) return;
      exitExploration();
      tools.release("Instrument released to focus the camera.");
      const sphere = targetBounds.getBoundingSphere(new THREE.Sphere());
      const radius = Math.max(sphere.radius, 22); // Keep surrounding context for very thin ducts.
      const vertical = THREE.MathUtils.degToRad(camera.fov / 2);
      const horizontal = Math.atan(Math.tan(vertical) * camera.aspect);
      const distance = radius / Math.sin(Math.min(vertical, horizontal)) * 1.12;
      const direction = camera.position.clone().sub(controls.target).normalize();
      if (!direction.lengthSq()) direction.set(0, 0, 1);
      const targetPosition = sphere.center.clone().addScaledVector(direction, distance);
      controls.minDistance = Math.max(radius * .3, 3);
      focusedOrgan = id; currentView = "orbit"; invalidate();
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        cameraTransition = null; camera.position.copy(targetPosition); controls.target.copy(sphere.center); controls.update();
      } else cameraTransition = { started: performance.now(), fromPosition: camera.position.clone(), toPosition: targetPosition, fromTarget: controls.target.clone(), toTarget: sphere.center.clone() };
      snapshot();
    };
    const applySelection = () => {
      cameraPlanner?.invalidate("Anatomy highlighting changed. Capture a fresh camera map.");
      invalidate();
      parts.forEach(part => {
        const selected = part.info.id === latest.current.selectedOrgan;
        const selection = part.mesh.material.userData.selectionUniform as THREE.IUniform<number> | undefined;
        if (selection) selection.value = selected ? 1 : 0;
        part.mesh.material.emissive.set(0x000000); part.mesh.material.emissiveIntensity = 0;
      });
    };
    const applyVisibility = () => {
      cameraPlanner?.invalidate("Anatomy visibility changed. Capture a fresh camera map.");
      exitExploration();
      tools.release("Visible anatomy changed; choose a new contact.");
      invalidate(true);
      const hidden = new Set(latest.current.hiddenOrgans ?? []);
      parts.forEach(part => { part.mesh.visible = latest.current.visibility[part.info.category] !== false && !hidden.has(part.info.id); });
      tools.syncOptions();
      snapshot();
    };
    const stats = (): WholeSceneStats => ({
      organs: parts.map(part => part.info),
      vertices: parts.reduce((sum, part) => sum + part.rest.length / 3, 0),
      triangles: parts.reduce((sum, part) => sum + (part.mesh.geometry.index?.count ?? part.rest.length / 3) / 3, 0),
      bounds: boxData(bounds),
    });
    const sceneMaterial = (info: WholeSceneOrgan, geometry?: THREE.BufferGeometry, source?: THREE.Object3D["userData"]) => { const tissue = isVirtaMed
      ? makeVirtaMedMaterial(info.id, latest.current.whiteSurface ?? true, vmTiles, tissueVolume, vmSample, vmInterfaces?.fields.get(info.id), vmOperative, latest.current.operativeResidue ?? .5)
      : makeWholeSceneTissueMaterial(info, latest.current.variation, breath, tissueVolume, { bowelFrontSide, reference: latest.current.referenceColors?.[info.id] });
      if(isVirtaMed&&geometry)applyVirtaMedVessels(geometry,tissue.material,source?.surfaceVessels,latest.current.whiteSurface??true);
      return tissue; };
    const applyVariation = () => {
      cameraPlanner?.invalidate("Anatomy shape changed. Capture a fresh camera map.");
      if (!parts.length) return;
      exitExploration(); navigationGuard.invalidate();
      tools.release("Surface variation changed; choose a new contact.");
      vmSample = isVirtaMed && vmSystem ? sampleVirtaMedVariation(vmSystem, latest.current.variation, latest.current.disease ?? "baseline",latest.current.textRecipe) : null;
      for (const part of parts) {
        const positions = part.info.id === "abdominal-wall" && isVirtaMed ? part.rest.slice() : vmSample ? warpVirtaMedPositions(part.rest, vmSample) : warpScenePositions(part.rest, latest.current.variation);
        part.variant = positions;
        const attribute = part.mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
        (attribute.array as Float32Array).set(positions); attribute.needsUpdate = true;
        updateTissueNormals(part.mesh.geometry, part.info.id); updateSceneBounds(part.mesh.geometry);
        const tissue = sceneMaterial(part.info,part.mesh.geometry,part.mesh.userData);
        part.mesh.material.dispose(); part.mesh.material = tissue.material; attachPhoto(tissue.material, part.info.id);
        part.geometrySignature = sceneBufferSignature(positions); part.materialSignature = tissue.signature;
      }
      fatLayers.warp(latest.current.variation);
      currentSceneBounds(parts.map(part => part.mesh.geometry), bounds);
      tools.geometryChanged(true); applyPhysics(); applySelection(); snapshot(); draw();
    };
    const applyReferenceColors = () => {
      cameraPlanner?.invalidate("Tissue appearance changed. Capture a fresh camera map.");
      // Material-only mutation: leave deformed buffers, camera and solver history intact.
      for (const part of parts) {
        const tissue = sceneMaterial(part.info,part.mesh.geometry,part.mesh.userData);
        if (part.materialSignature === tissue.signature) { tissue.material.dispose(); continue; }
        part.mesh.material.dispose(); part.mesh.material = tissue.material; attachPhoto(tissue.material, part.info.id); part.materialSignature = tissue.signature;
      }
      applySelection(); snapshot(); draw();
    };
    const syncPhysicsGeometry = (normals: boolean, normalPhase = -1) => {
      cameraPlanner?.invalidate("Tissue deformation changed the camera map.");
      const started = performance.now();
      navigationGuard.invalidate();
      invalidate(true);
      for (let partIndex = 0; partIndex < parts.length; partIndex++) {
        const part = parts[partIndex]!;
        // Bone is a fixed scaffold; avoid rebuilding its substantial mesh every physics frame.
        if (part.info.category === "skeleton") continue;
        const attribute = part.mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
        const positions = attribute.array as Float32Array;
        if (physics && part.binding) physics.deform(part.variant, positions, part.binding);
        else positions.set(part.variant);
        attribute.needsUpdate = true;
        if (normals || partIndex % 3 === normalPhase) {
          updateTissueNormals(part.mesh.geometry, part.info.id);
        }
        // Picking and instrument broad phases must bound the CURRENT surface,
        // including frames between normal recomputations.
        updateSceneBounds(part.mesh.geometry);
      }
      if(vmInterfaces)reconcileInterfaceNormals(parts.map(p=>({id:p.info.id,geometry:p.mesh.geometry})),vmInterfaces);
      fatLayers.sync(normals);
      currentSceneBounds(parts.map(part => part.mesh.geometry), bounds);
      tools.geometryChanged();
      geometryUploads++; surfaceCpuMs += performance.now() - started;
    };
    const applyPhysics = () => {
      cameraPlanner?.invalidate("Physics assignment changed. Capture a fresh camera map.");
      if (!parts.length) return;
      exitExploration();
      tools.release("Physics assignment changed; choose a new contact.");
      physics = null; fatLayers.bind(null); physicsFailed = false; physicsSteps = 0; wasPhysicsMoving = false;
      parts.forEach(part => { part.binding = null; });
      syncPhysicsGeometry(true);
      const materials = latest.current.physicsMaterials;
      if (materials) {
        try {
          const candidate = new WholeScenePhysics(parts.map(part => ({ id: part.info.id, category: part.info.category, bounds: boxData(part.mesh.geometry.boundingBox!) })), materials, isVirtaMed ? VIRTAMED_TISSUE_RESPONSE : {}, isVirtaMed ? [...(vmInterfaces?.edges ?? []), ...VIRTAMED_AUTHORED_PHYSICS_JOINTS] : undefined);
          // Build every binding before assigning the model; rejected material tables never partially apply.
          const bindings = parts.map(part => part.info.category === "skeleton" ? null : candidate.bind(part.variant, part.info.id));
          physics = candidate;
          parts.forEach((part, i) => { part.binding = bindings[i] ?? null; });
        } catch (error) { latest.current.onError(`Scene physics could not be applied: ${error instanceof Error ? error.message : String(error)}`); }
      }
      fatLayers.bind(physics);
      tools.syncOptions(); snapshot();
    };
    const pulsePhysics = () => { physics?.pulse(latest.current.selectedOrgan); snapshot(); };
    const resetPhysics = () => { exitExploration(); tools.release("Motion reset; choose a new contact."); physics?.reset(); physicsFailed = false; syncPhysicsGeometry(true); snapshot(); draw(); };
    const stopRecording = () => { if (recorder && recorder.state !== "inactive") recorder.stop(); };
    const recordScene = (kind: "tour" | "interaction", durationSeconds: number): Promise<Blob> => {
      if (!ready) return Promise.reject(new Error("Wait for the anatomy scene to finish loading."));
      if (cameraPlanner?.busy) return Promise.reject(new Error("Stop camera mapping or path replay before recording."));
      if (exploring) return Promise.reject(new Error("Return to orbit before starting a camera tour or instrument recording."));
      if (recorder || nativeRecording.active) return Promise.reject(new Error("A scene recording is already in progress."));
      if (kind === "interaction" && (!physics || !latest.current.physicsRunning || physicsFailed)) return Promise.reject(new Error("Apply and run learned physics before recording instrument interaction."));
      if (typeof MediaRecorder === "undefined" || typeof canvas.captureStream !== "function") return Promise.reject(new Error("This browser does not support canvas video recording. Use the angle views and PNG capture instead."));
      const duration = Math.max(3, Math.min(60, Number.isFinite(durationSeconds) ? durationSeconds : 12)) * 1000;
      const mimeType = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find(type => MediaRecorder.isTypeSupported(type));
      if (!mimeType) return Promise.reject(new Error("This browser cannot encode WebM video."));
      return new Promise<Blob>((resolve, reject) => {
        try {
          const stream = canvas.captureStream(30); recordingStream = stream;
          const activeRecorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
          recorder = activeRecorder;
          const chunks: BlobPart[] = [];
          let failure: Error | null = null;
          // A superior view has no useful azimuth orbit; start it from an oblique view.
          if (kind === "tour") {
            tools.release("Instrument released for the camera tour.");
            if (Math.hypot(camera.position.x - controls.target.x, camera.position.z - controls.target.z) < fitRadius) view("oblique");
          }
          cameraTransition = null;
          // Drain camera damping before locking the fixed interaction view.
          const previousDamping = controls.enableDamping;
          controls.enableDamping = false; controls.update(0); controls.enableDamping = previousDamping;
          const offset = camera.position.clone().sub(controls.target);
          recording = { kind, started: performance.now(), duration, angle: Math.atan2(offset.x, offset.z), distance: Math.hypot(offset.x, offset.z), elevation: offset.y };
          tools.syncOptions();
          activeRecorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
          activeRecorder.onerror = () => { failure = new Error("The browser could not finish encoding the scene recording."); stopRecording(); };
          activeRecorder.onstop = () => {
            if (recordingTimer) clearTimeout(recordingTimer); recordingTimer = null;
            stream.getTracks().forEach(track => track.stop()); recordingStream = null; recorder = null; recording = null;
            if (alive) { tools.syncOptions(); latest.current.onRecordingChange?.(false); snapshot(); }
            if (!alive) reject(new DOMException("Scene recording was cancelled when the viewer closed.", "AbortError"));
            else if (failure) reject(failure);
            else if (!chunks.length) reject(new Error("The browser produced an empty recording."));
            else resolve(new Blob(chunks, { type: mimeType }));
          };
          activeRecorder.start(200);
          latest.current.onRecordingChange?.(true); snapshot();
          recordingTimer = setTimeout(stopRecording, duration);
        } catch (error) {
          recordingStream?.getTracks().forEach(track => track.stop()); recordingStream = null; recorder = null; recording = null;
          tools.syncOptions();
          reject(error);
        }
      });
    };
    const recordTour = (seconds = 12) => recordScene("tour", seconds);
    const recordInteraction = (seconds = 20) => recordScene("interaction", seconds);
    cameraPlanner = new CameraPlannerScene({ renderer, scene, camera, controls,
      parts: () => parts, guard: navigationGuard, bounds: () => bounds.clone(),
      light: candidate => { if (laparoscope.update(candidate, inspectionIntensity || 30000)) renderer.shadowMap.needsUpdate = true; },
      restoreLight: () => { if (laparoscope.update(camera, exploring || operativeCamera ? inspectionIntensity : 0)) renderer.shadowMap.needsUpdate = true; },
      changed: () => { invalidate(true); }, publish: state => { if(alive) latest.current.onCameraPlannerChange?.(state); },
    });
    runtime.current = { captureCameraMap: (targets,signal) => {
        if (!ready || recording || nativeRecording.active) return Promise.reject(new Error("Load the scene and stop recording before mapping camera views."));
        exitExploration(true); tools.release("Camera mapping started; instrument released."); cameraTransition = null;
        return cameraPlanner!.capture(targets,signal);
      }, playCameraPath: (map,route) => {
        if (!ready || recording || nativeRecording.active) throw new Error("Stop recording before starting a camera path.");
        exitExploration(true); tools.release("Camera path started; instrument released."); cameraTransition = null; operativeCamera = true; currentView = "orbit";
        cameraPlanner!.play(map,route);
      }, stopCameraPath: () => cameraPlanner?.stop(), pauseCameraPath: () => cameraPlanner?.pause(),
      invalidateCameraMap: reason => { cameraPlanner?.invalidate(reason); invalidate(true); snapshot(); },
      videoView, fit, focusOrgan, view, captureMetadata, recordTour, stopRecording, applyFat, applyVariation, applyVisibility, applySelection, applyReferenceColors, applyPhysics, pulsePhysics, resetPhysics,
      enterExploration, exitExploration, resetExploration, moveExploration, lookExploration,
      recordInteraction, releaseTool: () => tools.release(), adjustToolDepth: delta => tools.adjustDepth(delta), engageSelectedTool: () => tools.engageSelected(), syncToolOptions: () => { if (cameraPlanner?.busy && (latest.current.autoRotate || latest.current.physicsRunning || (latest.current.toolMode ?? "orbit") !== "orbit")) cameraPlanner.stop("Manual simulation controls selected; camera planner stopped."); if (exploring && (latest.current.autoRotate || latest.current.physicsRunning || (latest.current.toolMode ?? "orbit") !== "orbit")) exitExploration(); if (latest.current.autoRotate) tools.release("Instrument released for camera rotation."); tools.syncOptions(); if (exploring) controls.enabled = false; snapshot(); },
      screenshot: () => {
        if (cameraPlanner?.capturing) { latest.current.onError("Wait for camera mapping to finish before saving an image."); return ""; }
        if (nativeRecording.active) { latest.current.onError("Stop scene recording before saving a still image."); return ""; }
        const previousSize = renderer.getSize(new THREE.Vector2()), previousRatio = renderer.getPixelRatio();
        const longEdge = Math.min(4096, renderer.capabilities.maxTextureSize);
        const scale = longEdge / Math.max(previousSize.x, previousSize.y);
        const width = Math.max(1, Math.round(previousSize.x * scale)), height = Math.max(1, Math.round(previousSize.y * scale));
        try {
          renderer.setPixelRatio(1); renderer.setSize(width, height, false); draw();
          const result = canvas.toDataURL("image/png");
          lastImageCapture = { width, height, materialVersion: isVirtaMed ? VIRTAMED_SURFACE_VERSION : WHOLE_SCENE_MATERIAL_VERSION };
          return result;
        } catch (error) {
          latest.current.onError(`The high-resolution image could not be saved: ${error instanceof Error ? error.message : String(error)}`);
          return "";
        } finally {
          renderer.setPixelRatio(previousRatio); renderer.setSize(previousSize.x, previousSize.y, false); draw(); snapshot();
        }
      } };
    const resize = () => {
      if (nativeRecording.active) return;
      invalidate();
      const width = Math.max(1, element.clientWidth || 700), height = Math.max(1, element.clientHeight || 800);
      renderer.setSize(width, height); camera.aspect = width / height; camera.updateProjectionMatrix();
      // Resizing a panel must preserve a user's focused, zoomed or inspection pose.
      snapshotAfterDraw = true;
    };
    const observer = new ResizeObserver(resize); observer.observe(element); resize();
    const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2();
    let pointerDown: [number, number] | null = null;
    const onPointerDown = (event: PointerEvent) => { if (cameraPlanner?.busy) cameraPlanner.stop("Manual camera control resumed."); if (!exploring) pointerDown = [event.clientX, event.clientY]; };
    const onPointerUp = (event: PointerEvent) => {
      if (exploring || !pointerDown || Math.hypot(event.clientX - pointerDown[0], event.clientY - pointerDown[1]) > 5) { pointerDown = null; return; }
      pointerDown = null;
      const rect = canvas.getBoundingClientRect();
      pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const candidates = parts.filter(part => part.mesh.visible && !["skeleton", "connective"].includes(part.info.category)).map(part => part.mesh);
      const hit = raycaster.intersectObjects(candidates, false)[0];
      latest.current.onSelect?.(hit ? String(hit.object.userData.organId) : null);
    };
    const onControlStart = () => { if (cameraPlanner?.busy) cameraPlanner.stop("Manual camera control resumed."); cameraTransition = null; currentView = "orbit"; };
    // Wheel/pan handlers update OrbitControls synchronously before the next RAF;
    // listening only to the RAF update return value misses those camera changes.
    const onControlChange = () => { invalidate(); if (!updatingControls) snapshotAfterDraw = true; };
    const onContextLost = (event: Event) => {
      cameraPlanner?.invalidate("Graphics context lost; camera planner stopped.");
      event.preventDefault(); ready = false; physicsFailed = true; exitExploration(); navigationKeys.clear(); releaseLookPointer();
      tools.release("Graphics context lost; instrument released."); stopRecording(); tools.syncOptions(); snapshot(); publishNavigation();
      latest.current.onError("The browser lost its 3D graphics context. Reload the scene tab to restart it.");
    };
    const consumeNavigation = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation(); };
    const onLookStart = (event: PointerEvent) => {
      if (!exploring || event.button !== 0 || lookPointer) return;
      consumeNavigation(event); lookPointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
      canvas.focus({ preventScroll: true }); canvas.setPointerCapture(event.pointerId);
    };
    const onLookMove = (event: PointerEvent) => {
      if (!exploring || lookPointer?.id !== event.pointerId) return;
      consumeNavigation(event);
      lookExploration(-(event.clientX - lookPointer.x) * .15, -(event.clientY - lookPointer.y) * .15);
      lookPointer.x = event.clientX; lookPointer.y = event.clientY;
    };
    const onLookEnd = (event: PointerEvent) => {
      if (lookPointer?.id !== event.pointerId) return;
      if (exploring) consumeNavigation(event);
      releaseLookPointer(); publishNavigation();
    };
    const movementKeys = new Set(["KeyW", "KeyS", "KeyA", "KeyD", "KeyQ", "KeyE", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);
    const onNavigationKey = (event: KeyboardEvent) => {
      if (event.code === "Escape" && cameraPlanner?.busy) { consumeNavigation(event); cameraPlanner.stop("Camera path stopped with Escape."); return; }
      if (!exploring) return;
      if (event.code === "Escape") { consumeNavigation(event); exitExploration(); return; }
      if (!movementKeys.has(event.code)) return;
      consumeNavigation(event); navigationKeys.add(event.code);
    };
    const onPlannerEscape = (event: KeyboardEvent) => { if (event.code === "Escape" && cameraPlanner?.busy) { event.preventDefault(); cameraPlanner.stop("Camera path stopped with Escape."); } };
    const onNavigationKeyUp = (event: KeyboardEvent) => { if (navigationKeys.delete(event.code)) publishNavigation(); };
    const clearNavigationInput = () => { navigationKeys.clear(); releaseLookPointer(); if (exploring) publishNavigation(); };
    const onNavigationWheel = (event: WheelEvent) => {
      if (cameraPlanner?.busy) cameraPlanner.stop("Manual camera zoom resumed.");
      if (!exploring) return;
      consumeNavigation(event); moveExploration(event.deltaY < 0 ? "forward" : "back", Math.min(30, Math.abs(event.deltaY) * .04));
    };
    canvas.addEventListener("pointerdown", onLookStart, true); canvas.addEventListener("pointermove", onLookMove, true);
    canvas.addEventListener("pointerup", onLookEnd, true); canvas.addEventListener("pointercancel", onLookEnd, true); canvas.addEventListener("lostpointercapture", onLookEnd, true);
    canvas.addEventListener("keydown", onNavigationKey, true); canvas.addEventListener("blur", clearNavigationInput);
    canvas.addEventListener("wheel", onNavigationWheel, { capture: true, passive: false });
    window.addEventListener("keydown", onPlannerEscape); window.addEventListener("keyup", onNavigationKeyUp); window.addEventListener("blur", clearNavigationInput);
    canvas.addEventListener("pointerdown", onPointerDown); canvas.addEventListener("pointerup", onPointerUp); canvas.addEventListener("webglcontextlost", onContextLost);
    controls.addEventListener("start", onControlStart); controls.addEventListener("change", onControlChange); controls.addEventListener("end", snapshot);
    let previousTime = performance.now(), lastPhysicsTime = previousTime;
    const animate = (now: number) => {
      if (!alive) return;
      animationFrames++;
      if (navigationPublishPending) publishNavigation(false);
      const elapsed = Math.max(0, (now - previousTime) / 1000);
      const delta = Math.min(elapsed, .1); previousTime = now;
      cameraPlanner?.tick(delta);
      const nextBreath = !isVirtaMed && !exploring && !physics && latest.current.breathing ? (Math.sin(now / 1000 * Math.PI * 2 / 4.8) + 1) * .5 : 0;
      if (nextBreath !== breath.value) { invalidate(true); fatLayers.sync(false, nextBreath); }
      breath.value = nextBreath;
      if (!exploring && !cameraPlanner?.busy && physics && latest.current.physicsRunning && !physicsFailed) {
        try {
          // Integrate every display frame; mesh upload cadence must not discard physical time.
          const solveStarted = performance.now(); physics.step(elapsed, latest.current.breathing); solverCpuMs += performance.now() - solveStarted;
          const moving = !isVirtaMed || latest.current.breathing || physics.motionActive;
          if ((moving || wasPhysicsMoving) && now - lastPhysicsTime >= (isVirtaMed ? 1000 / 60 - 2 : 50)) {
            physicsSteps++;
            // Spread exact normal work across frames; positions and collision
            // bounds always update together. Atlas retains its previous cadence.
            syncPhysicsGeometry(!isVirtaMed && physicsSteps % 3 === 0, isVirtaMed ? physicsSteps % 3 : -1);
            lastPhysicsTime = now;
            wasPhysicsMoving = moving;
          }
        } catch (error) { physicsFailed = true; latest.current.onError(`The physical simulation stopped: ${error instanceof Error ? error.message : String(error)}`); }
      } else lastPhysicsTime = now;
      tools.tick(now, delta);
      if (exploring) {
        controls.enabled = false;
        const forward = navigationDirection(navigationYaw, navigationPitch), movement = new THREE.Vector3();
        const keys: Record<string, WholeSceneNavigationDirection> = { KeyW: "forward", KeyS: "back", KeyA: "left", KeyD: "right", KeyQ: "down", KeyE: "up" };
        for (const [key, direction] of Object.entries(keys)) if (navigationKeys.has(key)) movement.add(navigationStep(direction, forward, 1));
        if (movement.lengthSq()) moveNavigation(movement.normalize().multiplyScalar(NAVIGATION_SPEED_MM_S * delta));
        const yaw = Number(navigationKeys.has("ArrowLeft")) - Number(navigationKeys.has("ArrowRight"));
        const pitch = Number(navigationKeys.has("ArrowUp")) - Number(navigationKeys.has("ArrowDown"));
        if (yaw || pitch) lookExploration(yaw * 55 * delta, pitch * 55 * delta);
      }
      if (tools.engaged || recording?.kind === "interaction") cameraTransition = null;
      if (cameraTransition) {
        invalidate();
        const progress = Math.min(1, (now - cameraTransition.started) / 550), ease = 1 - (1 - progress) ** 3;
        camera.position.lerpVectors(cameraTransition.fromPosition, cameraTransition.toPosition, ease);
        controls.target.lerpVectors(cameraTransition.fromTarget, cameraTransition.toTarget, ease);
        if (progress >= 1) cameraTransition = null;
      }
      if (recording?.kind === "tour") {
        cameraTransition = null;
        const angle = recording.angle + Math.min(1, (now - recording.started) / recording.duration) * Math.PI * 2;
        camera.position.set(controls.target.x + Math.sin(angle) * recording.distance, controls.target.y + recording.elevation, controls.target.z + Math.cos(angle) * recording.distance);
        currentView = "orbit";
      }
      controls.autoRotate = !cameraPlanner?.busy && !exploring && latest.current.autoRotate && !recording && !cameraTransition && !tools.engaged;
      if (controls.autoRotate) currentView = "orbit";
      updatingControls = true;
      const controlsChanged = cameraPlanner?.busy || exploring || tools.engaged || recording?.kind === "interaction" ? false : controls.update(delta);
      updatingControls = false;
      if (controlsChanged) invalidate();
      const activeMotion = Boolean(cameraPlanner?.moving || nativeRecording.active || recording || cameraTransition || (!exploring && (latest.current.autoRotate || (!isVirtaMed && !physics && latest.current.breathing) || (physics && latest.current.physicsRunning && !physicsFailed && (!isVirtaMed || latest.current.breathing || physics.motionActive)))));
      if (renderPending || activeMotion) draw();
      if (now - lastSnapshot > 500) { snapshot(); lastSnapshot = now; }
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);
    const load = async () => {
      let loaded: THREE.Group | null = null;
      try {
        const prefix = `${import.meta.env.BASE_URL}anatomy-scene/`;
        if (isVirtaMed) {
          vmTiles = await loadVirtaMedTiles(abort.signal);
          vmOperative = await loadOperativeAppearance(abort.signal);
          vmSystem = await loadImportedVariationSystem(abort.signal);
          if (!alive) return;
          const authored = await loadVirtaMedAsset(abort.signal); manifest = authored.manifest as Manifest; loaded = authored.root;
          vmAsset = { sha256: authored.sha256, bytes: authored.bytes, version: authored.manifest.version };
        } else {
          const [manifestResponse, glbResponse] = await Promise.all([
            fetch(`${prefix}manifest.json`, { signal: abort.signal }), fetch(`${prefix}bodyparts3d-torso.glb`, { signal: abort.signal }),
          ]);
          if (!manifestResponse.ok || !glbResponse.ok) throw new Error("The bundled anatomical atlas could not be loaded.");
          const [data, buffer] = await Promise.all([manifestResponse.json(), glbResponse.arrayBuffer()]);
          if (!alive) return;
          manifest = data as Manifest;
          if (!Array.isArray(manifest.organs) || !manifest.organs.length) throw new Error("The anatomy manifest has no organs.");
          const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(buffer, prefix);
          loaded = gltf.scene;
        }
        reportReady("scene");
        if (!alive) { disposeObject(loaded); return; }
        loaded.updateMatrixWorld(true);
        const byId = new Map(manifest.organs.map(info => [info.id, info]));
        loaded.traverse(object => {
          if (!(object instanceof THREE.Mesh)) return;
          const id = String(object.userData.id ?? object.name);
          const info = byId.get(id);
          if (!info) throw new Error(`The atlas mesh ${id} is missing its anatomical label.`);
          if (!WHOLE_SCENE_CATEGORIES.includes(info.category)) throw new Error(`The atlas category ${info.category} is unsupported.`);
          // a quantized atlas (KHR_mesh_quantization: 16-bit positions and normals, the scale in the node) is widened to
          // floats first: everything below bakes matrices into the arrays and reads them as floats
          for (const name of ["position", "normal", "_tissue_occlusion"]) {
            const attribute = object.geometry.getAttribute(name);
            if (!attribute || attribute.array instanceof Float32Array) continue;
            const wide = new Float32Array(attribute.count * attribute.itemSize);
            for (let i = 0; i < attribute.count; i++) for (let k = 0; k < attribute.itemSize; k++) wide[i * attribute.itemSize + k] = attribute.getComponent(i, k);
            object.geometry.setAttribute(name, new THREE.BufferAttribute(wide, attribute.itemSize));
          }
          let geometry = object.geometry.clone().applyMatrix4(object.matrixWorld);
          if (!isVirtaMed && /^(liver|stomach|gallbladder|small-intestine|colon|spleen|pancreas)$/.test(info.id)) {
            computeAngleWeightedNormals(geometry);
            const refined = pnSubdivideGeometry(geometry, .46); geometry.dispose(); geometry = refined;
            fairSurfaceConcavityOutliers(geometry, 4); computeAngleWeightedNormals(geometry);
          }
          const positions = geometry.getAttribute("position");
          const rest = new Float32Array(positions.array);
          geometry.setAttribute("sceneRestPosition", new THREE.BufferAttribute(rest.slice(), 3));
          const sourceOcclusion = geometry.getAttribute("_tissue_occlusion");
          if (sourceOcclusion && (sourceOcclusion.itemSize !== 1 || sourceOcclusion.count !== positions.count)) throw new Error(`The tissue occlusion field for ${id} does not match its surface.`);
          const occlusion = sourceOcclusion ?? new THREE.BufferAttribute(new Float32Array(positions.count).fill(1), 1);
          geometry.setAttribute("sceneTissueOcclusion", occlusion);
          geometry.computeBoundingBox(); geometry.computeBoundingSphere();
          const tissue = sceneMaterial(info,geometry,object.userData);
          const mesh = new THREE.Mesh(geometry, tissue.material); mesh.name = info.id; mesh.userData = {...object.userData,organId:info.id}; attachPhoto(tissue.material, info.id);
          const opaqueTissue = isVirtaMed ? true : info.category !== "skeleton" && info.category !== "connective";
          mesh.castShadow = opaqueTissue; mesh.receiveShadow = opaqueTissue;
          if (opaqueTissue) mesh.customDepthMaterial = makeWholeSceneDepthMaterial(breath);
          let minimumOcclusion = 1, maximumOcclusion = 0;
          if (sourceOcclusion) for (let i = 0; i < sourceOcclusion.count; i++) {
            const value = sourceOcclusion.getX(i);
            if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`The tissue occlusion field for ${id} is invalid.`);
            minimumOcclusion = Math.min(minimumOcclusion, value); maximumOcclusion = Math.max(maximumOcclusion, value);
          }
          mesh.userData.ambientOcclusion = { enabled: Boolean(sourceOcclusion), min: minimumOcclusion, max: sourceOcclusion ? maximumOcclusion : 1, maximumAmbientAttenuation: .35 };
          mesh.renderOrder = info.category === "skeleton" ? 2 : info.category === "connective" ? 1 : 0;
          assembly.add(mesh); bounds.union(geometry.boundingBox!);
          parts.push({ info, mesh, rest, variant: rest.slice(), binding: null, restBounds: boxData(geometry.boundingBox!), geometrySignature: sceneBufferSignature(rest), materialSignature: tissue.signature });
        });
        disposeObject(loaded); loaded = null;
        if (!parts.length) throw new Error("The anatomical atlas contains no renderable surfaces.");
        if (parts.length !== manifest.organs.length) throw new Error("The anatomy manifest and rendered structure count do not match.");
        if(isVirtaMed)vmInterfaces=buildVirtaMedInterfaces(parts.map(p=>({id:p.info.id,geometry:p.mesh.geometry,attachments:p.mesh.userData.attachments,coverRange:p.mesh.userData.coverRange})));
        applyVariation(); applyVisibility(); fit(); ready = true; applyFat(); tools.syncOptions(); snapshot();
        if (isVirtaMed) videoView();
        latest.current.onReady?.(stats()); publishNavigation();
      } catch (error) {
        if (loaded) disposeObject(loaded);
        // Incomplete atlas loads must not leave a plausible-looking partial body.
        disposeObject(assembly); assembly.clear(); parts.length = 0; ready = false; physics = null; invalidate(true);
        snapshot();
        if (alive && !(error instanceof DOMException && error.name === "AbortError")) latest.current.onError(`The anatomical scene could not load: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    void load();
    return () => {
      cameraPlanner?.dispose();
      alive = false; abort.abort(); cancelAnimationFrame(frame); observer.disconnect();
      if (recordingTimer) clearTimeout(recordingTimer); stopRecording(); recordingStream?.getTracks().forEach(track => track.stop());
      tools.dispose();
      clearNavigationInput();
      canvas.removeEventListener("pointerdown", onLookStart, true); canvas.removeEventListener("pointermove", onLookMove, true);
      canvas.removeEventListener("pointerup", onLookEnd, true); canvas.removeEventListener("pointercancel", onLookEnd, true); canvas.removeEventListener("lostpointercapture", onLookEnd, true);
      canvas.removeEventListener("keydown", onNavigationKey, true); canvas.removeEventListener("blur", clearNavigationInput); canvas.removeEventListener("wheel", onNavigationWheel, true);
      window.removeEventListener("keydown", onPlannerEscape); window.removeEventListener("keyup", onNavigationKeyUp); window.removeEventListener("blur", clearNavigationInput);
      canvas.removeEventListener("pointerdown", onPointerDown); canvas.removeEventListener("pointerup", onPointerUp); canvas.removeEventListener("webglcontextlost", onContextLost);
      controls.removeEventListener("start", onControlStart); controls.removeEventListener("change", onControlChange); controls.removeEventListener("end", snapshot); controls.dispose();
      nativeRecording.dispose(); navigationGuard.invalidate(); fatLayers.dispose(); disposeObject(assembly); tissueVolume.dispose(); if(vmTiles) disposeVirtaMedTiles(vmTiles); vmOperative?.texture.dispose(); operativeEnvelope?.dispose(); laparoscope.dispose(); cameraOptics?.dispose(); environment.dispose(); fatLamp.shadow.dispose(); renderer.dispose(); renderer.forceContextLoss(); canvas.remove(); runtime.current = null;
      if (diagnostics.__visceraSceneSnapshot === captureMetadata) delete diagnostics.__visceraSceneSnapshot;
      delete element.dataset.sceneSnapshot; delete element.dataset.sceneReady;
    };
  }, []);
  useEffect(() => { runtime.current?.applyFat(); }, [props.fatOptions]);
  useEffect(() => { runtime.current?.applyVariation(); }, [props.variation, props.disease, props.textRecipe]);
  useEffect(() => { runtime.current?.applyReferenceColors(); }, [props.referenceColors, props.bodyReferencePlan, props.whiteSurface, props.operativeResidue]);
  useEffect(() => { runtime.current?.applyVisibility(); }, [props.visibility, props.hiddenOrgans]);
  useEffect(() => { runtime.current?.applySelection(); }, [props.selectedOrgan]);
  useEffect(() => { runtime.current?.applyPhysics(); }, [props.physicsMaterials]);
  useEffect(() => { runtime.current?.syncToolOptions(); }, [props.toolMode, props.toolRadiusMm, props.toolDepthMm, props.continuousPush, props.pushSpeedMmS, props.physicsRunning, props.autoRotate, props.selectedOrgan]);
  return <div ref={host} className="whole-scene-canvas" style={{ width: "100%", height: "100%", minHeight: 440 }} />;
});
