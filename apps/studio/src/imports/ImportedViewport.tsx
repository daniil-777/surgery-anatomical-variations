import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import {
  ACESFilmicToneMapping, Box3, Color, DirectionalLight, HemisphereLight,
  Mesh, PerspectiveCamera, PMREMGenerator, Scene, Vector3, WebGLRenderer,
  type Object3D,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { registerSceneRecordingSource } from "../sceneRecordingSource";

export type ImportedCameraPreset = "anterior" | "subhepatic" | "hepatobiliary" | "foregut" | "posterior";

export interface ImportedViewportHandle {
  fit(): void;
  view(preset: ImportedCameraPreset): void;
}

interface CameraPresetSpec {
  direction: [number, number, number];
  targetOffset: [number, number, number];
  distanceScale: number;
}

const CAMERA_PRESET_SPECS: Record<ImportedCameraPreset, CameraPresetSpec> = {
  anterior: {
    direction: [0.04, 0.05, 1],
    targetOffset: [0, 0.02, 0],
    distanceScale: 1.04,
  },
  subhepatic: {
    direction: [-0.14, -0.32, 0.94],
    targetOffset: [-0.05, 0.23, 0.06],
    distanceScale: 0.56,
  },
  hepatobiliary: {
    direction: [-0.46, -0.14, 0.88],
    targetOffset: [-0.10, 0.23, 0.04],
    distanceScale: 0.62,
  },
  foregut: {
    direction: [0.48, 0.06, 0.87],
    targetOffset: [0.12, 0.21, -0.02],
    distanceScale: 0.64,
  },
  posterior: {
    direction: [0.04, 0.06, -1],
    targetOffset: [0, 0.10, -0.04],
    distanceScale: 0.88,
  },
};

/** The parent owns the imported assets. Camera fitting never alters exported transforms. */
export const ImportedViewport = forwardRef<ImportedViewportHandle, {
  object: Object3D | null;
  revision: number;
  autoRotate: boolean;
  onError(message: string): void;
}>(function ImportedViewport({ object, revision, autoRotate, onError }, forwardedRef) {
  const host = useRef<HTMLDivElement>(null);
  const live = useRef({ object, autoRotate, onError });
  live.current = { object, autoRotate, onError };
  const runtime = useRef<{ scene: Scene; fit(): void; view(preset: ImportedCameraPreset): void; draw(): void } | null>(null);
  useImperativeHandle(forwardedRef, () => ({
    fit: () => runtime.current?.fit(),
    view: (preset: ImportedCameraPreset) => runtime.current?.view(preset),
  }), []);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let renderer: WebGLRenderer;
    try { renderer = new WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true }); }
    catch { live.current.onError("The 3D viewer could not start. Check that WebGL is enabled in your browser."); return; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.90;
    renderer.setClearColor(new Color("#091016"));
    renderer.domElement.setAttribute("aria-label", "Imported 3D model. Drag to orbit, scroll to zoom.");
    renderer.domElement.tabIndex = 0;
    element.appendChild(renderer.domElement);
    const scene = new Scene();
    const camera = new PerspectiveCamera(34, 1, 0.001, 10000);
    camera.position.set(0.24, 0.16, 4);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.listenToKeyEvents(renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.autoRotateSpeed = 0.75;
    scene.add(new HemisphereLight(0xe3e8f2, 0x463836, 0.62));
    const key = new DirectionalLight(0xfff0e5, 1.85);
    key.position.set(-3.5, 4.8, 6.2); scene.add(key);
    const fill = new DirectionalLight(0xd6e4f5, 0.42);
    fill.position.set(4.2, 1.5, 3.5); scene.add(fill);
    const rim = new DirectionalLight(0xe5cbc4, 0.58);
    rim.position.set(1.8, 3.0, -5.5); scene.add(rim);
    // Coaxial laparoscope camera light so subhepatic / deep peritoneal recesses catch wet serosal specular highlights
    const scopeLight = new DirectionalLight(0xfff6ed, 0.58);
    scene.add(scopeLight, scopeLight.target);
    const environment = new RoomEnvironment();
    const generator = new PMREMGenerator(renderer);
    const environmentTarget = generator.fromScene(environment, 0.05);
    scene.environment = environmentTarget.texture;
    scene.environmentIntensity = 0.36;
    environment.dispose(); generator.dispose();
    let disposed = false, frame = 0, renderNeeded = true;
    const requestDraw = () => { renderNeeded = true; };
    const draw = () => {
      if (!disposed && !renderer.getContext().isContextLost()) {
        scopeLight.position.copy(camera.position);
        scopeLight.target.position.copy(controls.target);
        renderer.render(scene, camera);
        renderNeeded = false;
      }
    };
    controls.addEventListener("change", requestDraw);
    const recording = registerSceneRecordingSource({
      renderer, camera, host: element, label: "Imported 3D model", draw,
      available: () => Boolean(live.current.object),
    });
    const resize = () => {
      if (recording.active) return;
      const width = Math.max(1, element.clientWidth), height = Math.max(1, element.clientHeight);
      renderer.setSize(width, height);
      camera.aspect = width / height; camera.updateProjectionMatrix(); draw();
    };
    const applyCameraSpec = (
      dirVec: Vector3,
      distanceScale = 1.04,
      targetOffset: [number, number, number] = [0, 0, 0],
    ) => {
      const root = live.current.object;
      if (!root) return;
      root.updateMatrixWorld(true);
      const box = new Box3().setFromObject(root);
      if (box.isEmpty()) return;
      const center = box.getCenter(new Vector3());
      const boxSize = box.getSize(new Vector3());
      const target = center.clone().add(new Vector3(
        boxSize.x * targetOffset[0],
        boxSize.y * targetOffset[1],
        boxSize.z * targetOffset[2],
      ));
      const radius = Math.max(boxSize.length() * 0.5, 0.000001);
      const halfAngle = Math.min(camera.fov * Math.PI / 360,
        Math.atan(Math.tan(camera.fov * Math.PI / 360) * camera.aspect));
      const distance = radius / Math.sin(halfAngle) * distanceScale;
      const direction = dirVec.clone().normalize();
      if (!direction.lengthSq()) direction.set(0.06, 0.04, 1).normalize();
      camera.up.set(0, 1, 0);
      controls.target.copy(target);
      camera.position.copy(target).addScaledVector(direction, distance);
      camera.near = Math.max(radius / 1000, 0.0000001);
      camera.far = Math.max(radius * 200, distance * 4);
      controls.minDistance = radius * 0.02;
      controls.maxDistance = radius * 60;
      camera.updateProjectionMatrix();
      controls.update();
      draw();
    };
    const fit = () => {
      const currentDir = camera.position.clone().sub(controls.target);
      if (!currentDir.lengthSq()) currentDir.set(0.06, 0.04, 1);
      applyCameraSpec(currentDir, 1.04, [0, 0, 0]);
    };
    const view = (preset: ImportedCameraPreset) => {
      const spec = CAMERA_PRESET_SPECS[preset] ?? CAMERA_PRESET_SPECS.anterior;
      applyCameraSpec(
        new Vector3(spec.direction[0], spec.direction[1], spec.direction[2]),
        spec.distanceScale,
        spec.targetOffset,
      );
    };
    runtime.current = { scene, fit, view, draw };
    const observer = new ResizeObserver(resize); observer.observe(element); resize();
    let previousFrame: number | undefined;
    const tick = (time: number) => {
      if (disposed) return;
      controls.autoRotate = live.current.autoRotate;
      // Keep turntable speed independent of device/recording frame rate.
      // Bound a background-tab gap so returning to the model never jumps.
      const delta = previousFrame === undefined ? 0 : Math.min(0.1, (time - previousFrame) / 1000);
      previousFrame = time;
      const controlsMoved = controls.update(delta);
      if (controlsMoved || live.current.autoRotate || recording.active || renderNeeded) {
        draw();
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    const lost = (event: Event) => {
      event.preventDefault();
      live.current.onError("The graphics context was lost. Reload the workspace to restore the viewer.");
    };
    renderer.domElement.addEventListener("webglcontextlost", lost);
    return () => {
      disposed = true; cancelAnimationFrame(frame); observer.disconnect();
      runtime.current = null; recording.dispose(); controls.dispose();
      renderer.domElement.removeEventListener("webglcontextlost", lost);
      if (live.current.object?.parent === scene) scene.remove(live.current.object);
      environmentTarget.dispose(); renderer.dispose(); renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, []);

  useEffect(() => {
    const viewer = runtime.current;
    if (!viewer || !object) return;
    viewer.scene.add(object); viewer.view("anterior");
    return () => { viewer.scene.remove(object); };
  }, [object]);

  useEffect(() => {
    object?.traverse(node => {
      if (node instanceof Mesh) {
        node.geometry.computeBoundingBox(); node.geometry.computeBoundingSphere();
      }
    });
    runtime.current?.draw();
  }, [object, revision]);

  return <div ref={host} className="import-viewport" data-import-ready={Boolean(object)} />;
});
