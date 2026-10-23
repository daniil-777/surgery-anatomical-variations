import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import {
  ACESFilmicToneMapping, Box3, Color, DirectionalLight, HemisphereLight,
  Mesh, PerspectiveCamera, PMREMGenerator, Scene, Vector3, WebGLRenderer,
  type Object3D,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { registerSceneRecordingSource } from "../sceneRecordingSource";

export interface ImportedViewportHandle { fit(): void }

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
  const runtime = useRef<{ scene: Scene; fit(): void; draw(): void } | null>(null);
  useImperativeHandle(forwardedRef, () => ({ fit: () => runtime.current?.fit() }), []);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let renderer: WebGLRenderer;
    try { renderer = new WebGLRenderer({ antialias: true, alpha: false }); }
    catch { live.current.onError("The 3D viewer could not start. Check that WebGL is enabled in your browser."); return; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.setClearColor(new Color("#101b20"));
    renderer.domElement.setAttribute("aria-label", "Imported 3D model. Drag to orbit, scroll to zoom.");
    renderer.domElement.tabIndex = 0;
    element.appendChild(renderer.domElement);
    const scene = new Scene();
    const camera = new PerspectiveCamera(42, 1, 0.001, 10000);
    camera.position.set(3, 2, 4);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.listenToKeyEvents(renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.autoRotateSpeed = 0.75;
    scene.add(new HemisphereLight(0xeaf5ff, 0x34453c, 1.3));
    const key = new DirectionalLight(0xfff3e4, 2.6);
    key.position.set(4, 6, 5); scene.add(key);
    const fill = new DirectionalLight(0xc7ddff, 1);
    fill.position.set(-4, 1, -3); scene.add(fill);
    const environment = new RoomEnvironment();
    const generator = new PMREMGenerator(renderer);
    const environmentTarget = generator.fromScene(environment, 0.04);
    scene.environment = environmentTarget.texture;
    environment.dispose(); generator.dispose();
    let disposed = false, frame = 0;
    const draw = () => {
      if (!disposed && !renderer.getContext().isContextLost()) renderer.render(scene, camera);
    };
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
    const fit = () => {
      const root = live.current.object;
      if (!root) return;
      root.updateMatrixWorld(true);
      const box = new Box3().setFromObject(root);
      if (box.isEmpty()) return;
      const center = box.getCenter(new Vector3());
      const radius = Math.max(box.getSize(new Vector3()).length() * 0.5, 0.000001);
      const halfAngle = Math.min(camera.fov * Math.PI / 360,
        Math.atan(Math.tan(camera.fov * Math.PI / 360) * camera.aspect));
      const distance = radius / Math.sin(halfAngle) * 1.16;
      const direction = camera.position.clone().sub(controls.target).normalize();
      if (!direction.lengthSq()) direction.set(1, 0.6, 1).normalize();
      controls.target.copy(center); camera.position.copy(center).addScaledVector(direction, distance);
      camera.near = Math.max(radius / 1000, 0.0000001);
      camera.far = Math.max(radius * 200, distance * 4);
      controls.minDistance = radius * 0.02; controls.maxDistance = radius * 60;
      camera.updateProjectionMatrix(); controls.update(); draw();
    };
    runtime.current = { scene, fit, draw };
    const observer = new ResizeObserver(resize); observer.observe(element); resize();
    let previousFrame: number | undefined;
    const tick = (time: number) => {
      if (disposed) return;
      controls.autoRotate = live.current.autoRotate;
      // Keep turntable speed independent of device/recording frame rate.
      // Bound a background-tab gap so returning to the model never jumps.
      const delta = previousFrame === undefined ? 0 : Math.min(0.1, (time - previousFrame) / 1000);
      previousFrame = time;
      controls.update(delta); draw();
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
    viewer.scene.add(object); viewer.fit();
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
