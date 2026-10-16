import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { SceneData } from "@viscera/render";
import { installAtlasMaterial, readAtlasMaterial } from "./atlasMaterialShader";
import { physicsSurfacePositions, type PhysicsRun } from "./atlasPhysics";

interface Props { scene: SceneData; run: PhysicsRun | null; frame: number }
interface Runtime { organ: THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>; tool: THREE.Group; controls: OrbitControls; fit: () => void }

export function AtlasPhysicsViewport({ scene: sourceScene, run, frame }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const runtime = useRef<Runtime | null>(null);
  const [error, setError] = useState("");
  const [wireframe, setWireframe] = useState(false);
  useEffect(() => {
    const element = host.current;
    const source = sourceScene.organs[0];
    if (!element || !source) return;
    setError("");
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true }); }
    catch { setError("The 3D viewer could not start. Metrics and downloaded trajectories remain available."); return; }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.95;
    renderer.domElement.setAttribute("aria-label", "Liver physics playback. Drag to orbit and scroll to zoom.");
    element.appendChild(renderer.domElement);
    const world = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(34, 1, 0.01, 10000);
    camera.position.set(270, 160, 340);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    const environment = pmrem.fromScene(room, 0.06);
    room.dispose(); pmrem.dispose(); world.environment = environment.texture;
    world.add(new THREE.HemisphereLight(0xe2edff, 0x55515b, 0.65));
    const key = new THREE.DirectionalLight(0xfff1e4, 2); key.position.set(-400, 600, 500); world.add(key);
    const rim = new THREE.DirectionalLight(0xc8e8ff, 1); rim.position.set(400, 200, -360); world.add(rim);
    const geometry = new THREE.BufferGeometry();
    const cutting = run?.protocol === "cut";
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(cutting ? run.mesh.reference_positions_mm : source.positions, 3));
    geometry.setIndex(cutting ? run.mesh.surface_indices : source.indices);
    geometry.computeVertexNormals();
    const material = new THREE.MeshPhysicalMaterial({ color: cutting ? "#944138" : source.colors ? "#ffffff" : source.color, roughness: 0.45, clearcoat: 0.15, clearcoatRoughness: 0.28, metalness: 0, side: THREE.DoubleSide, envMapIntensity: 0.25 });
    if (!cutting && source.colors) {
      const colors = new Float32Array(source.colors.length); const color = new THREE.Color();
      for (let i = 0; i < colors.length; i += 3) { color.setRGB(source.colors[i]!, source.colors[i + 1]!, source.colors[i + 2]!, THREE.SRGBColorSpace); colors.set([color.r, color.g, color.b], i); }
      geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3)); material.vertexColors = true;
    }
    if (!cutting) {
      try { const definition = readAtlasMaterial(source, sourceScene); if (definition) installAtlasMaterial(geometry, material, definition); }
      catch (cause) { setError(cause instanceof Error ? cause.message : "The source tissue material is unavailable."); }
    }
    const organ = new THREE.Mesh(geometry, material); world.add(organ);
    const bounds = new THREE.Box3().setFromObject(organ);
    const center = bounds.getCenter(new THREE.Vector3());
    const radius = Math.max(1, bounds.getBoundingSphere(new THREE.Sphere()).radius);
    const tool = new THREE.Group();
    const toolMaterial = new THREE.MeshStandardMaterial({ color: "#c7d8dc", roughness: 0.25, metalness: 0.65 });
    const tipMaterial = new THREE.MeshStandardMaterial({ color: "#87d6c3", roughness: 0.3, metalness: 0.3 });
    const cutPlaneMaterial = new THREE.MeshBasicMaterial({ color: "#a9dbd1", transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false });
    const radiusMm = run?.tool.radius_mm ?? 8;
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.4, 65, 16), toolMaterial); shaft.position.y = 38; tool.add(shaft);
    if (run?.protocol === "grasp") {
      for (const side of [-1, 1]) {
        const jaw = new THREE.Mesh(new THREE.BoxGeometry(2, 14, 4), toolMaterial); jaw.position.set(side * 5, 3, 0); jaw.rotation.z = side * -0.18; tool.add(jaw);
      }
    } else if (cutting) {
      const cutPlane = new THREE.Mesh(new THREE.PlaneGeometry(bounds.getSize(new THREE.Vector3()).z * 1.04, 17), cutPlaneMaterial);
      cutPlane.rotation.y = Math.PI / 2; cutPlane.position.y = 4; tool.add(cutPlane);
    } else tool.add(new THREE.Mesh(new THREE.SphereGeometry(radiusMm, 24, 16), tipMaterial));
    tool.visible = Boolean(run); world.add(tool);
    const fit = () => {
      const direction = new THREE.Vector3(0.6, 0.48, 1).normalize();
      const right = new THREE.Vector3(0, 1, 0).cross(direction).normalize();
      const up = direction.clone().cross(right).normalize();
      const vertical = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      const horizontal = vertical * camera.aspect;
      const point = new THREE.Vector3(); const attribute = geometry.getAttribute("position");
      let distance = radius;
      for (let index = 0; index < attribute.count; index++) {
        point.fromBufferAttribute(attribute, index).sub(center);
        distance = Math.max(distance, Math.abs(point.dot(right)) / horizontal + point.dot(direction), Math.abs(point.dot(up)) / vertical + point.dot(direction));
      }
      // Fit the actual organ silhouette, so millimetre motion remains visible.
      // The long, illustrative shaft may extend beyond the frame.
      camera.position.copy(center).addScaledVector(direction, distance * 1.14);
      controls.target.copy(center);
      camera.near = radius / 10000; camera.far = radius * 200; camera.updateProjectionMatrix(); controls.update();
    };
    let initialSize = true;
    const resize = new ResizeObserver(() => {
      if (!element.clientWidth || !element.clientHeight) return;
      renderer.setSize(element.clientWidth, element.clientHeight); camera.aspect = element.clientWidth / element.clientHeight; camera.updateProjectionMatrix();
      if (initialSize) { fit(); initialSize = false; }
    }); resize.observe(element);
    runtime.current = { organ, tool, controls, fit };
    let animation = 0;
    const render = () => { animation = requestAnimationFrame(render); if (!document.hidden) { controls.update(); renderer.render(world, camera); } }; render();
    const lost = (event: Event) => { event.preventDefault(); setError("Graphics context lost. Reopen the lab to restore the viewer."); };
    renderer.domElement.addEventListener("webglcontextlost", lost);
    return () => {
      cancelAnimationFrame(animation); resize.disconnect(); controls.dispose(); environment.dispose();
      world.traverse(child => { if (child instanceof THREE.Mesh) child.geometry.dispose(); });
      material.dispose(); toolMaterial.dispose(); tipMaterial.dispose(); cutPlaneMaterial.dispose(); renderer.domElement.removeEventListener("webglcontextlost", lost); renderer.dispose(); renderer.domElement.remove(); runtime.current = null;
    };
  }, [sourceScene, run]);

  useEffect(() => {
    const state = runtime.current; const current = run?.frames[frame]; const source = sourceScene.organs[0];
    if (!state || !run || !current || !source) return;
    const positions = run.protocol === "cut" ? current.positions_mm : physicsSurfacePositions(source.positions, run, current);
    const attribute = state.organ.geometry.getAttribute("position") as THREE.BufferAttribute;
    attribute.copyArray(positions); attribute.needsUpdate = true;
    if (run.protocol === "cut" && current.active_surface_indices && state.organ.geometry.userData.severedBonds !== current.severed_bonds) {
      state.organ.geometry.setIndex(current.active_surface_indices); state.organ.geometry.userData.severedBonds = current.severed_bonds;
    }
    state.organ.geometry.computeVertexNormals(); state.organ.geometry.computeBoundingSphere();
    state.tool.position.fromArray(current.tool_position_mm);
  }, [run, frame, sourceScene]);
  useEffect(() => { if (runtime.current) runtime.current.organ.material.wireframe = wireframe; }, [wireframe, run]);

  return <div className="physics-viewer">
    <div ref={host} className="physics-canvas" data-testid="physics-viewport" />
    <div className="physics-viewer-caption"><span>{run?.protocol === "cut" ? "TETRAHEDRAL CUT SURFACE" : "DISPLAYED LIVER · EMBEDDED SURFACE"}</span><small>{run?.protocol === "cut" ? "Coarse seam · full-width scripted cut-plane marker" : "Rest-space tissue appearance follows deformation"}</small></div>
    <div className="physics-viewer-tools"><button className="atlas-btn" onClick={() => runtime.current?.fit()}>Reset view</button><button className="atlas-btn" aria-pressed={wireframe} onClick={() => setWireframe(!wireframe)}>Wireframe</button></div>
    {error && <p className="physics-render-error" role="alert">{error}</p>}
    <span className="physics-orbit-hint">Drag to orbit · Scroll to zoom</span>
  </div>;
}
