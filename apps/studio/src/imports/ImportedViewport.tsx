import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import {
  ACESFilmicToneMapping, Box3, Color,
  Mesh, PerspectiveCamera, Scene, Vector3, WebGLRenderer,
  type Object3D,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { SceneNavigationGuard, navigationAngles, navigationDirection, navigationStep, type NavigationSurface, type WholeSceneNavigationDirection } from "../wholeSceneNavigation";
import { createOperativeEnvelope, operativeEntry, OPERATIVE_REGIONS, type OperativeRegion } from "../operativeView";
import { FatSceneLayerView } from "../fat/sceneLayerView";
import { BASELINE_VARIATION } from "../wholeSceneModel";
import { createSurgicalLighting } from "./surgicalLighting";
import { registerSceneRecordingSource } from "../sceneRecordingSource";

export type ImportedCameraPreset = "anterior" | "subhepatic" | "hepatobiliary" | "foregut" | "posterior";
export interface ImportedViewportHandle { fit(): void; view(preset: ImportedCameraPreset): void; inspect(region: OperativeRegion): void; exit(): void }

/** The parent owns the imported assets. Camera fitting never alters exported transforms. */
export const ImportedViewport = forwardRef<ImportedViewportHandle, {
  object: Object3D | null;
  revision: number;
  autoRotate: boolean;
  onError(message: string): void;
}>(function ImportedViewport({ object, revision, autoRotate, onError }, forwardedRef) {
  const [scopeRegion, setScopeRegion] = useState<OperativeRegion | null>(null);
  const [scopeMessage, setScopeMessage] = useState("");
  const host = useRef<HTMLDivElement>(null);
  const live = useRef({ object, autoRotate, onError });
  live.current = { object, autoRotate, onError };
  const runtime = useRef<{ scene: Scene; fit(): void; view(preset: ImportedCameraPreset): void; draw(): void; inspect(region: OperativeRegion): void; exit(): void; move(direction: WholeSceneNavigationDirection): void } | null>(null);
  useImperativeHandle(forwardedRef, () => ({ fit: () => runtime.current?.fit(), view: preset => runtime.current?.view(preset), inspect: region => runtime.current?.inspect(region), exit: () => runtime.current?.exit() }), []);

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
    const lighting = createSurgicalLighting(scene, renderer, camera);
    let sceneRadius = 1;
    let disposed = false, frame = 0;
    let internal = false, yaw = 0, pitch = 0, workingDistance = 60;
    let savedPose: {position: Vector3; target: Vector3; fov: number} | null = null;
    let envelope: ReturnType<typeof createOperativeEnvelope> = null;
    let fat: FatSceneLayerView | null = null;
    let sources: {id: string; mesh: Mesh; rest: Float32Array}[] = [];
    const surfaces = (): NavigationSurface[] => [...sources.map(part => ({id: part.id, visible: true, geometry: part.mesh.geometry})),
      ...(fat?.navigationSurfaces() ?? []), ...(envelope ? [{id: envelope.mesh.name, visible: true, geometry: envelope.mesh.geometry}] : [])];
    const guard = new SceneNavigationGuard(surfaces);
    const keys = new Set<string>();
    let drag: {id: number; x: number; y: number} | null = null;
    const diagnostic = () => { element.dataset.operativeScope = JSON.stringify({active:internal, position:camera.position.toArray(), direction:camera.getWorldDirection(new Vector3()).toArray(), workingDistance, fat:fat?.snapshot().status ?? "disabled", wall:Boolean(envelope)}); };
    const pose = () => {
      const forward = navigationDirection(yaw,pitch);
      controls.target.copy(camera.position).addScaledVector(forward, 30); camera.lookAt(controls.target); camera.updateMatrixWorld();
      workingDistance = Math.max(22,Math.min(100,guard.rayDistance(camera.position,forward,120))); diagnostic();
    };
    const move = (direction: WholeSceneNavigationDirection, distance = 8) => {
      if (!internal) return;
      const bounds = new Box3().setFromObject(live.current.object!).expandByScalar(sceneRadius);
      const result = guard.move(camera.position,camera.position.clone().add(navigationStep(direction,navigationDirection(yaw,pitch),distance)),bounds);
      camera.position.copy(result.position); pose();
      setScopeMessage(result.blocked ? `Near ${result.blockedBy?.replaceAll("-"," ")}. Retreat or turn to continue.` : "Drag to look · W/S forward/back · A/D sideways · Q/E up/down · Esc returns");
    };
    const exitScope = () => {
      if (!internal) return;
      internal = false; keys.clear(); drag = null; fat?.dispose(); fat = null; envelope?.dispose(); envelope = null;
      sources.forEach(part => part.mesh.geometry.dispose()); sources = []; guard.invalidate();
      lighting.setInternal(false); controls.enabled = true;
      if (savedPose) { camera.position.copy(savedPose.position); controls.target.copy(savedPose.target); camera.fov=savedPose.fov; }
      savedPose = null; camera.updateProjectionMatrix();
      renderer.setClearColor(new Color("#101b20")); setScopeRegion(null); diagnostic();
    };
    const inspect = (region: OperativeRegion) => {
      const root = live.current.object; if (!root) return;
      const original = savedPose ?? {position:camera.position.clone(),target:controls.target.clone(),fov:camera.fov};
      exitScope(); root.updateMatrixWorld(true);
      root.traverse(node => { if (node instanceof Mesh && node.visible) {
        const geometry=node.geometry.clone().applyMatrix4(node.matrixWorld);geometry.computeBoundingBox();
        sources.push({id:node.name,mesh:new Mesh(geometry,node.material),rest:Float32Array.from(geometry.getAttribute("position").array)});
      }});
      guard.invalidate();
      const entry = operativeEntry(surfaces(),region,guard);
      if (!entry) {sources.forEach(part=>part.mesh.geometry.dispose());sources=[];live.current.onError("This entry requires named abdominal structures. Load the laparoscopic scene preset first.");return;}
      savedPose=original; internal=true; controls.enabled=false; controls.autoRotate=false;
      camera.position.copy(entry.position); const angles=navigationAngles(entry.forward);yaw=angles.yaw;pitch=angles.pitch;
      camera.fov=70; camera.near=.1; camera.updateProjectionMatrix(); lighting.setInternal(true);
      envelope=createOperativeEnvelope(surfaces());if(envelope)scene.add(envelope.mesh);
      fat=new FatSceneLayerView(scene,()=>sources,BASELINE_VARIATION,()=>{guard.invalidate();diagnostic();},message=>live.current.onError(message));
      fat.configure({enabled:true,seed:42,thicknessMm:5,omentum:true,perirenal:true,wetness:.48});
      renderer.setClearColor(new Color("#100807")); setScopeRegion(region); pose();
      setScopeMessage("Drag to look · W/S forward/back · A/D sideways · Q/E up/down · Esc returns");
      renderer.domElement.focus({preventScroll:true});
    };
    const keydown = (event: KeyboardEvent) => {
      if(!internal)return;if(event.key==="Escape"){event.preventDefault();exitScope();return;}
      if(/[wasdqe]/.test(event.key.toLowerCase())&&event.key.length===1){event.preventDefault();keys.add(event.key.toLowerCase());}
      const look: Record<string,[number,number]>={ArrowLeft:[.07,0],ArrowRight:[-.07,0],ArrowUp:[0,.07],ArrowDown:[0,-.07]};
      if(look[event.key]){event.preventDefault();yaw+=look[event.key]![0];pitch=Math.max(-1.5,Math.min(1.5,pitch+look[event.key]![1]));pose();}
    };
    const keyup=(event:KeyboardEvent)=>keys.delete(event.key.toLowerCase());
    const clearKeys=()=>keys.clear();
    const pointerdown=(event:PointerEvent)=>{if(internal&&event.button===0){drag={id:event.pointerId,x:event.clientX,y:event.clientY};renderer.domElement.setPointerCapture(event.pointerId);}};
    const pointermove=(event:PointerEvent)=>{if(internal&&drag?.id===event.pointerId){yaw-=(event.clientX-drag.x)*.003;pitch=Math.max(-1.5,Math.min(1.5,pitch-(event.clientY-drag.y)*.003));drag.x=event.clientX;drag.y=event.clientY;pose();}};
    const pointerup=()=>{drag=null;};
    const wheel=(event:WheelEvent)=>{if(internal){event.preventDefault();move(event.deltaY<0?"forward":"back",4);}};
    const canvas=renderer.domElement;
    canvas.addEventListener("keydown",keydown);canvas.addEventListener("keyup",keyup);canvas.addEventListener("blur",clearKeys);
    canvas.addEventListener("pointerdown",pointerdown);canvas.addEventListener("pointermove",pointermove);canvas.addEventListener("pointerup",pointerup);canvas.addEventListener("pointercancel",pointerup);canvas.addEventListener("wheel",wheel,{passive:false});
    const draw = () => {
      if (!disposed && !renderer.getContext().isContextLost()) {
        lighting.update(controls.target, sceneRadius, internal ? workingDistance : undefined);
        renderer.render(scene, camera);
      }
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
    const fit = (preset?: ImportedCameraPreset) => {
      exitScope();
      const root = live.current.object;
      if (!root) return;
      root.updateMatrixWorld(true);
      const box = new Box3();
      const focus = preset === "subhepatic" || preset === "hepatobiliary"
        ? /gallbladder|hepatic-duct|hepatic-artery|portal-vein/
        : preset === "foregut" ? /stomach|duodenum|pancreas|spleen|splenic-artery/ : null;
      if (focus) root.traverse(node => { if (node instanceof Mesh && focus.test(node.name)) box.expandByObject(node); });
      if (box.isEmpty()) box.setFromObject(root);
      if (box.isEmpty()) return;
      const center = box.getCenter(new Vector3());
      const radius = Math.max(box.getSize(new Vector3()).length() * 0.5, 0.000001);
      sceneRadius = Math.max(new Box3().setFromObject(root).getSize(new Vector3()).length() * .5, radius);
      const halfAngle = Math.min(camera.fov * Math.PI / 360,
        Math.atan(Math.tan(camera.fov * Math.PI / 360) * camera.aspect));
      const distance = radius / Math.sin(halfAngle) * 1.16;
      const direction = camera.position.clone().sub(controls.target).normalize();
      if (preset) direction.set(...({
        anterior: [0, 0.05, 1], subhepatic: [0.15, -0.65, 1],
        hepatobiliary: [-0.85, -0.35, 1], foregut: [0.65, -0.15, 1], posterior: [0, 0.05, -1],
      } satisfies Record<ImportedCameraPreset, [number, number, number]>)[preset]).normalize();
      if (!direction.lengthSq()) direction.set(1, 0.6, 1).normalize();
      controls.target.copy(center); camera.position.copy(center).addScaledVector(direction, distance);
      camera.near = Math.max(radius / 1000, 0.0000001);
      camera.far = Math.max(radius * 200, distance * 4);
      controls.minDistance = radius * 0.02; controls.maxDistance = radius * 60;
      camera.updateProjectionMatrix(); controls.update(); draw();
    };
    runtime.current = { scene, fit, view: preset => fit(preset), draw, inspect, exit: exitScope, move };
    const observer = new ResizeObserver(resize); observer.observe(element); resize();
    let previousFrame: number | undefined;
    const tick = (time: number) => {
      if (disposed) return;
      controls.autoRotate = !internal && live.current.autoRotate;
      // Keep turntable speed independent of device/recording frame rate.
      // Bound a background-tab gap so returning to the model never jumps.
      const delta = previousFrame === undefined ? 0 : Math.min(0.1, (time - previousFrame) / 1000);
      previousFrame = time;
      if (internal) {
        const directions: Record<string,WholeSceneNavigationDirection>={w:"forward",s:"back",a:"left",d:"right",q:"down",e:"up"};
        for(const key of keys)if(directions[key])move(directions[key]!,delta*35/Math.sqrt(keys.size));
      } else controls.update(delta); draw();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    const lost = (event: Event) => {
      event.preventDefault();
      live.current.onError("The graphics context was lost. Reload the workspace to restore the viewer.");
    };
    renderer.domElement.addEventListener("webglcontextlost", lost);
    return () => {
      exitScope();
      canvas.removeEventListener("keydown",keydown);canvas.removeEventListener("keyup",keyup);canvas.removeEventListener("blur",clearKeys);
      canvas.removeEventListener("pointerdown",pointerdown);canvas.removeEventListener("pointermove",pointermove);canvas.removeEventListener("pointerup",pointerup);canvas.removeEventListener("pointercancel",pointerup);canvas.removeEventListener("wheel",wheel);
      disposed = true; cancelAnimationFrame(frame); observer.disconnect();
      runtime.current = null; recording.dispose(); controls.dispose();
      renderer.domElement.removeEventListener("webglcontextlost", lost);
      if (live.current.object?.parent === scene) scene.remove(live.current.object);
      lighting.dispose(); renderer.dispose(); renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, []);

  useEffect(() => {
    const viewer = runtime.current;
    if (!viewer || !object) return;
    object.traverse(node => { if (node instanceof Mesh) { node.castShadow = true; node.receiveShadow = true; } });
    viewer.scene.add(object); viewer.fit();
    return () => { viewer.exit(); viewer.scene.remove(object); };
  }, [object]);

  useEffect(() => {
    runtime.current?.exit();
    object?.traverse(node => {
      if (node instanceof Mesh) {
        node.geometry.computeBoundingBox(); node.geometry.computeBoundingSphere();
      }
    });
    runtime.current?.draw();
  }, [object, revision]);

  return <div ref={host} className={`import-viewport${scopeRegion ? " is-operative" : ""}`} data-import-ready={Boolean(object)}>
    {scopeRegion && <div className="import-scope-guide">
      <div><strong>{OPERATIVE_REGIONS.find(region=>region.id===scopeRegion)?.label}</strong><button onClick={()=>runtime.current?.exit()}>Return to overview</button></div>
      <p>{OPERATIVE_REGIONS.find(region=>region.id===scopeRegion)?.description}</p>
      <nav aria-label="Move scope">{(["forward","back","left","right","up","down"] as const).map(direction=><button key={direction} onClick={()=>runtime.current?.move(direction)}>{direction}</button>)}</nav>
      <small role="status">{scopeMessage}</small><small>Cavity and fat are preview layers. GLB exports your organ scene.</small>
    </div>}
  </div>;
});
