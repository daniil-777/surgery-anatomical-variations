import { SceneResizeHandle } from "./DisplaySettings";
import { apiOnline, apiUrl } from "./api";
import { bundledPlayground } from "./atlasLocal";
import { useEffect, useRef, useState } from "react";
import { Circle, Download, Hand, LoaderCircle, Maximize, Move, Pause, Play, RotateCcw, Square, Zap } from "lucide-react";
import * as THREE from "three";
import { registerSceneRecordingSource } from "./sceneRecordingSource";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { atlasError, type AtlasGeneration } from "./atlas";
import { installAtlasMaterial, readAtlasMaterial } from "./atlasMaterialShader";
import { readPhysicsPlayground, type PhysicsObservation, type PhysicsParameters, type PhysicsPlayground, type PhysicsSource } from "./atlasPhysics";
import { LiverPlaygroundSolver } from "./liverPlaygroundSolver";
import { createLaparoscopicInstrument } from "./laparoscopicInstruments";
import { fitLiverView, liverInCameraFrame } from "./liverPlaygroundView";
import { LiverMotionCapture } from "./liverMotionCapture";
import "./atlasPhysicsPlayground.css";

type Tool = "grab" | "push" | "punch" | "orbit";
type Metrics = ReturnType<LiverPlaygroundSolver["metrics"]>;
interface Props {
  generation: AtlasGeneration;
  source: PhysicsSource;
  parameters: PhysicsParameters;
  observation: PhysicsObservation | null;
  revision: number;
  enabled: boolean;
  onPrepared: (value: PhysicsPlayground | null) => void;
}
interface Runtime { solver: LiverPlaygroundSolver; resetView: () => void; fitView: () => void; release: () => void; punchCenter: () => void; recordSample: (now: number) => void }
const tools: { id: Tool; label: string; icon: typeof Hand }[] = [
  { id: "grab", label: "Grab", icon: Hand }, { id: "push", label: "Push", icon: Move },
  { id: "punch", label: "Punch", icon: Zap }, { id: "orbit", label: "Orbit", icon: RotateCcw },
];
const instructions: Record<Tool, string> = {
  grab: "Aim the grasper at the liver. Hold to close the jaws, then drag to lift or stretch. Release to open.",
  push: "Aim the blunt probe at the liver. Hold and drag downward to press deeper; drag sideways to sweep.",
  punch: "Click or tap the liver to strike with the blunt probe. Adjust the impulse strength below.",
  orbit: "Drag anywhere to look around the room. Scroll or pinch to zoom.",
};
const fmt = (value: number, digits = 2) => value.toFixed(digits);

/** Browser mechanics and material coordinates share the exact source embedding. */
export function AtlasPhysicsPlayground(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const diagnostics = useRef<HTMLDivElement>(null);
  const runtime = useRef<Runtime | null>(null);
  const recording = useRef<LiverMotionCapture | null>(null);
  const [capture, setCapture] = useState({ active: false, count: 0, limit: 0, reason: "" });
  const [inFrame, setInFrame] = useState(true);
  const latest = useRef(props); latest.current = props;
  const [prepared, setPrepared] = useState<PhysicsPlayground | null>(null);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [tool, setTool] = useState<Tool>("grab");
  const [radius, setRadius] = useState(28);
  const [probeRadius, setProbeRadius] = useState(6);
  const [strength, setStrength] = useState(0.65);
  const [paused, setPaused] = useState(false);
  const [gravity, setGravity] = useState(true);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [fps, setFps] = useState(0);
  const [shapeStrain, setShapeStrain] = useState(0);
  const [heightChange, setHeightChange] = useState(0);
  const [speedRatio, setSpeedRatio] = useState(1);
  const [wallElapsed, setWallElapsed] = useState(0);
  const [bodyState, setBodyState] = useState("Settling");
  const interaction = useRef({ tool, radius, probeRadius, strength, paused, gravity });
  interaction.current = { tool, radius, probeRadius, strength, paused, gravity };
  const loadedKey = useRef("");
  const updateCapture = () => { const value = recording.current; setCapture({ active: value?.active ?? false, count: value?.count ?? 0, limit: value?.sampleLimit ?? 0, reason: value?.reason ?? "" }); };
  const mark = (action: string, startsSegment = false) => recording.current?.event(action, performance.now(), startsSegment);
  const toggleRecording = () => {
    if (recording.current?.active) { mark("recording_stopped"); recording.current.stop(); }
    else if (prepared && runtime.current) { const now = performance.now(); recording.current = new LiverMotionCapture(prepared, now); runtime.current.recordSample(now); }
    updateCapture();
  };
  const downloadMotion = () => {
    if (!recording.current?.count) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(recording.current.export(), null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "viscera-liver-motion.json"; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  useEffect(() => {
    const key = JSON.stringify([props.generation.spec, props.revision, retry]);
    if (!props.enabled || loadedKey.current === key) { if (!props.enabled) setLoading(false); return; }
    const controller = new AbortController(); let live = true;
    setLoading(true); setRetrying(false); setError("");
    const input = latest.current;
    const prepare = async () => {
      // StrictMode tears down its first effect before this continuation runs.
      await Promise.resolve();
      if (!live || controller.signal.aborted) throw new DOMException("Preparation stopped", "AbortError");
      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await fetch(apiUrl("/api/physics/playground"), {
          method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
          body: JSON.stringify({ spec: input.generation.spec, parameter_source: input.source,
            ...(input.source === "manual" ? { parameters: input.parameters } : input.observation ? { observation: input.observation } : {}) }),
        });
        if (response.status !== 503 || attempt === 2) return response;
        if (live) setRetrying(true);
        const retryAfter = Number(response.headers.get("Retry-After") ?? 2);
        await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(new DOMException("Preparation stopped", "AbortError")); };
          const timer = window.setTimeout(() => { controller.signal.removeEventListener("abort", abort); resolve(); }, Math.max(0.5, Math.min(Number.isFinite(retryAfter) ? retryAfter : 2, 5)) * 1000);
          if (controller.signal.aborted) abort(); else controller.signal.addEventListener("abort", abort, { once: true });
        });
      }
      throw new Error("The physics service is still preparing another liver. Try again shortly.");
    };
    // the public copy: the API's preparation of the reference livers, bundled (atlasLocal.ts)
    const payload = async (): Promise<unknown> => {
      if (!(await apiOnline())) return bundledPlayground(input.generation, input.source, input.parameters, input.observation, controller.signal);
      const response = await prepare();
      if (!response.ok) throw await atlasError(response);
      return response.json();
    };
    void payload().then(async value => {
      const next = readPhysicsPlayground(value, { spec: input.generation.spec, parameter_source: input.source, vertices: input.generation.scene.organs[0]!.positions.length / 3 });
      if (!live || controller.signal.aborted) return;
      loadedKey.current = key; setPrepared(next); input.onPrepared(next); setPaused(false); setGravity(true);
    }).catch(cause => { if (live && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : "The interactive scene could not be prepared."); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; controller.abort(); };
  }, [props.generation, props.revision, props.enabled, retry]);

  useEffect(() => {
    const element = host.current; const source = props.generation.scene.organs[0];
    if (!element || !source || !prepared) return;
    let solver: LiverPlaygroundSolver;
    try { solver = new LiverPlaygroundSolver(prepared.mesh, prepared.parameters, { floorYmm: prepared.room.floor_y_mm, gravity: true }); solver.drop(75); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The liver could not be initialized for interactive physics."); return; }
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance", preserveDrawingBuffer: true }); }
    catch { setError("WebGL could not start. Reopen the lab in a browser with WebGL support."); return; }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75)); renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.1;
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.domElement.tabIndex = 0;
    renderer.domElement.setAttribute("aria-label", "Hands-on liver. Drag to manipulate; right drag to orbit. Arrow keys grab and move, Enter releases, P punches, F fits the liver in view.");
    element.appendChild(renderer.domElement);
    const world = new THREE.Scene(); world.background = new THREE.Color("#1b2931");
    const camera = new THREE.PerspectiveCamera(38, 1, 1, 8000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.dampingFactor = 0.12;
    controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
    controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    controls.maxPolarAngle = Math.PI * 0.49; controls.minPolarAngle = Math.PI * 0.08;
    const pmrem = new THREE.PMREMGenerator(renderer); const room = new RoomEnvironment();
    const environment = pmrem.fromScene(room, 0.06); room.dispose(); pmrem.dispose(); world.environment = environment.texture;
    world.add(new THREE.HemisphereLight(0xdceeff, 0x263630, 1.0));
    const key = new THREE.DirectionalLight(0xfff0dc, 3.0); key.position.set(-350, 680, 430);
    key.castShadow = true; key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, { left: -450, right: 450, top: 600, bottom: -400, near: 10, far: 1800 });
    key.shadow.bias = -0.0002; key.shadow.normalBias = 0.25; key.shadow.radius = 3; world.add(key);
    const fill = new THREE.DirectionalLight(0xafd4e7, 0.8); fill.position.set(350, 300, -200); world.add(fill);
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute("position", new THREE.Float32BufferAttribute(source.positions, 3)); geometry.setIndex(source.indices);
    geometry.computeVertexNormals();
    const material = new THREE.MeshPhysicalMaterial({ color: source.colors ? "#ffffff" : source.color, roughness: 0.46, clearcoat: 0.16, clearcoatRoughness: 0.28, side: THREE.DoubleSide, envMapIntensity: 0.4 });
    if (source.colors) {
      const color = new THREE.Color(); const colors = new Float32Array(source.colors.length);
      for (let i = 0; i < colors.length; i += 3) { color.setRGB(source.colors[i]!, source.colors[i + 1]!, source.colors[i + 2]!, THREE.SRGBColorSpace); colors.set([color.r, color.g, color.b], i); }
      geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3)); material.vertexColors = true;
    }
    try { const appearance = readAtlasMaterial(source, props.generation.scene); if (appearance) installAtlasMaterial(geometry, material, appearance); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The source material could not be applied."); }
    const organ = new THREE.Mesh(geometry, material); organ.castShadow = true; organ.receiveShadow = true; world.add(organ);
    const restBounds = new THREE.Box3().setFromBufferAttribute(geometry.getAttribute("position") as THREE.BufferAttribute);
    const extent = restBounds.getSize(new THREE.Vector3()); const organSize = Math.max(extent.x, extent.y, extent.z);
    const floorSize = Math.max(1000, organSize * 7); const floorY = prepared.room.floor_y_mm;
    world.fog = new THREE.Fog("#1b2931", floorSize * 0.5, floorSize * 2.2);
    const floorMaterial = new THREE.MeshStandardMaterial({ color: "#30424a", roughness: 0.93, metalness: 0.02 });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(floorSize, floorSize), floorMaterial); floor.rotation.x = -Math.PI / 2; floor.position.y = floorY; floor.receiveShadow = true; world.add(floor);
    const grid = new THREE.GridHelper(floorSize, Math.round(floorSize / 25), 0x687b82, 0x425760); grid.position.y = floorY + 0.2;
    const gridMaterial = grid.material as THREE.LineBasicMaterial; gridMaterial.transparent = true; gridMaterial.opacity = 0.36; world.add(grid);
    const wallMaterial = new THREE.MeshStandardMaterial({ color: "#263943", roughness: 1 });
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(floorSize, floorSize * 0.65), wallMaterial);
    wall.position.set(0, floorY + floorSize * 0.325, -floorSize * 0.4); wall.receiveShadow = true; world.add(wall);
    const sideWall = new THREE.Mesh(new THREE.PlaneGeometry(floorSize, floorSize * 0.65), wallMaterial); sideWall.rotation.y = Math.PI / 2;
    sideWall.position.set(-floorSize * 0.4, floorY + floorSize * 0.325, 0); sideWall.receiveShadow = true; world.add(sideWall);
    const grasper = createLaparoscopicInstrument("grasper");
    const palpator = createLaparoscopicInstrument("probe");
    world.add(grasper.group, palpator.group);
    const probeTarget = new THREE.Vector3();
    const resetView = () => {
      const distance = organSize * (camera.aspect < 1 ? 3.15 : 2.5);
      camera.position.set(distance * 0.62, floorY + distance * 0.58, distance * 0.85);
      controls.target.set(0, floorY + extent.y * 0.43 + 18, 0); controls.minDistance = organSize * 0.6; controls.maxDistance = floorSize * 1.7; controls.update();
    };
    const attribute = geometry.getAttribute("position") as THREE.BufferAttribute;
    const surfaceArray = attribute.array as Float32Array;
    const edgeMap = new Map<string, { a: number; b: number; length: number }>();
    for (let offset = 0; offset < prepared.mesh.tets.length; offset += 4) for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) {
      const one = prepared.mesh.tets[offset + a]!, two = prepared.mesh.tets[offset + b]!;
      const key = `${Math.min(one, two)}:${Math.max(one, two)}`;
      if (!edgeMap.has(key)) edgeMap.set(key, { a: one * 3, b: two * 3, length: Math.hypot(...[0, 1, 2].map(axis => solver.referenceMm[one * 3 + axis]! - solver.referenceMm[two * 3 + axis]!)) });
    }
    const edges = [...edgeMap.values()];
    const updateSurface = () => {
      const embedding = prepared.mesh.embedding; const tets = prepared.mesh.tets;
      for (let vertex = 0; vertex < source.positions.length / 3; vertex++) {
        const tetOffset = embedding.tet_indices[vertex]! * 4;
        for (let axis = 0; axis < 3; axis++) {
          let displacement = 0;
          for (let corner = 0; corner < 4; corner++) { const node = tets[tetOffset + corner]! * 3 + axis; displacement += embedding.weights[vertex * 4 + corner]! * (solver.positionsMm[node]! - solver.referenceMm[node]!); }
          surfaceArray[vertex * 3 + axis] = source.positions[vertex * 3 + axis]! + displacement;
        }
      }
      attribute.needsUpdate = true; geometry.computeVertexNormals(); geometry.computeBoundingSphere(); geometry.computeBoundingBox();
    };
    updateSurface(); resetView();
    const raycaster = new THREE.Raycaster(); const pointer = new THREE.Vector2();
    const dragPlane = new THREE.Plane(); const dragTarget = new THREE.Vector3(); const dragOffset = new THREE.Vector3(); const startPoint = new THREE.Vector3(); const hitNormal = new THREE.Vector3(); const dragRight = new THREE.Vector3();
    const instrumentAxis = new THREE.Vector3(0, 1, 0); const localShaftAxis = new THREE.Vector3(0, 0, 1);
    const pose = new THREE.Quaternion();
    let activePointer: number | null = null; let startY = 0; let activeTool: Tool = "grab"; let keyboardGrab = false;
    let hoverPointer: { x: number; y: number } | null = null;
    let hoverAnchor: { indices: [number, number, number]; weights: THREE.Vector3; normal: THREE.Vector3 } | null = null;
    let lastAim = 0; let jawClosure = 0; let instrumentEngaged = false;
    let strike: { time: number; point: THREE.Vector3; axis: THREE.Vector3 } | null = null;
    const ray = (x: number, y: number) => { const rect = renderer.domElement.getBoundingClientRect(); pointer.set((x - rect.left) / rect.width * 2 - 1, -(y - rect.top) / rect.height * 2 + 1); raycaster.setFromCamera(pointer, camera); };
    const centerIntersection = () => {
      const center = geometry.boundingBox!.getCenter(new THREE.Vector3()); const projected = center.clone().project(camera);
      raycaster.setFromCamera(new THREE.Vector2(projected.x, projected.y), camera);
      return raycaster.intersectObject(organ)[0];
    };
    const centerHit = () => centerIntersection()?.point.clone() ?? geometry.boundingBox!.getCenter(new THREE.Vector3());
    const outwardNormal = (hit: THREE.Intersection) => {
      const normal = hit.face?.normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(organ.matrixWorld)).normalize()
        ?? camera.position.clone().sub(hit.point).normalize();
      if (normal.dot(raycaster.ray.direction) > 0) normal.negate();
      return normal;
    };
    const approachAxis = (normal: THREE.Vector3) => {
      // Approach diagonally from the upper right, leaving the tissue visible.
      const axis = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).multiplyScalar(1.2)
        .addScaledVector(new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1), 0.1).addScaledVector(normal, 0.35).normalize();
      axis.y = Math.max(axis.y, 0.28); axis.normalize();
      if (axis.dot(normal) < 0.25) axis.addScaledVector(normal, 0.6).normalize();
      return axis;
    };
    const rememberAim = (hit: THREE.Intersection) => {
      if (!hit.face) return;
      const { a, b, c } = hit.face;
      const weights = THREE.Triangle.getBarycoord(hit.point, new THREE.Vector3().fromBufferAttribute(attribute, a), new THREE.Vector3().fromBufferAttribute(attribute, b), new THREE.Vector3().fromBufferAttribute(attribute, c), new THREE.Vector3());
      if (weights) hoverAnchor = { indices: [a, b, c], weights, normal: outwardNormal(hit) };
    };
    const release = () => {
      const contact = solver.interactionState();
      if (contact.grab || contact.probe) mark("contact_released");
      solver.endGrab(); solver.setProbe(null); activePointer = null; keyboardGrab = false; controls.enabled = true;
      strike = null; lastAim = 0;
    };
    const fitView = () => {
      // Keep an engaged tool attached while only the camera moves. Rebase the
      // pointer plane so its next movement cannot jump the mechanical target.
      let previousPointerHit: THREE.Vector3 | null = null;
      if (activePointer !== null && hoverPointer) {
        ray(hoverPointer.x, hoverPointer.y);
        previousPointerHit = raycaster.ray.intersectPlane(dragPlane, new THREE.Vector3());
      }
      // Flush OrbitControls momentum before explicit framing; never move tissue.
      const damping = controls.enableDamping; controls.enableDamping = false; controls.update();
      const center = fitLiverView(camera, geometry.boundingBox!);
      controls.target.copy(center); controls.maxDistance = Math.max(floorSize * 1.7, camera.position.distanceTo(center) * 1.2);
      controls.update(); controls.enableDamping = damping;
      if (previousPointerHit && hoverPointer) {
        ray(hoverPointer.x, hoverPointer.y);
        const nextPointerHit = raycaster.ray.intersectPlane(dragPlane, new THREE.Vector3());
        if (nextPointerHit) dragOffset.add(previousPointerHit.sub(nextPointerHit));
      }
      mark("fit_liver_view"); setInFrame(liverInCameraFrame(camera, geometry.boundingBox!));
    };
    const strikeAt = (point: THREE.Vector3) => {
      const direction = camera.getWorldDirection(new THREE.Vector3());
      const before = recording.current?.active ? solver.velocities.slice() : null;
      solver.punch(point.toArray(), direction.toArray(), interaction.current.strength, interaction.current.radius);
      if (before) {
        const impulse = [0, 0, 0]; let kineticChange = 0;
        for (let i = 0; i < solver.masses.length; i++) for (let axis = 0; axis < 3; axis++) {
          const offset = i * 3 + axis, mass = solver.masses[i]!;
          impulse[axis]! += mass * (solver.velocities[offset]! - before[offset]!);
          kineticChange += .5 * mass * (solver.velocities[offset]! ** 2 - before[offset]! ** 2);
        }
        recording.current?.event("punch", performance.now(), false, { point_mm: point.toArray(), direction: direction.toArray(), requested_speed_m_s: interaction.current.strength, influence_radius_mm: interaction.current.radius, impulse_on_body_n_s: impulse, kinetic_energy_change_j: kineticChange });
      }
      strike = { time: performance.now(), point: point.clone(), axis: direction.negate() };
    };
    const punchCenter = () => { if (!interaction.current.paused) { release(); strikeAt(centerHit()); } };
    const down = (event: PointerEvent) => {
      if (event.pointerType === "touch" && !event.isPrimary && activePointer !== null) { event.preventDefault(); event.stopPropagation(); return; }
      if (event.button !== 0 || interaction.current.tool === "orbit" || interaction.current.paused) return;
      ray(event.clientX, event.clientY); const hit = raycaster.intersectObject(organ)[0];
      if (!hit) return;
      event.preventDefault(); event.stopPropagation(); renderer.domElement.focus({ preventScroll: true });
      release(); controls.enabled = false; activePointer = event.pointerId; activeTool = interaction.current.tool;
      hoverPointer = { x: event.clientX, y: event.clientY }; rememberAim(hit);
      renderer.domElement.setPointerCapture(event.pointerId); startY = event.clientY; startPoint.copy(hit.point); dragTarget.copy(hit.point); dragOffset.set(0, 0, 0);
      hitNormal.copy(outwardNormal(hit)); instrumentAxis.copy(approachAxis(hitNormal));
      dragPlane.setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()), hit.point);
      dragRight.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
      if (activeTool === "grab") { if (!solver.beginGrab(hit.point.toArray(), interaction.current.radius)) release(); }
      else if (activeTool === "push") {
        const r = interaction.current.probeRadius;
        probeTarget.copy(hit.point).addScaledVector(hitNormal, r - 2 * interaction.current.strength);
        probeTarget.y = Math.max(probeTarget.y, floorY + r);
        solver.setProbe(probeTarget.toArray(), r);
      } else if (activeTool === "punch") strikeAt(hit.point);
    };
    const move = (event: PointerEvent) => {
      hoverPointer = { x: event.clientX, y: event.clientY };
      if (event.pointerId !== activePointer) { lastAim = 0; return; }
      event.preventDefault(); event.stopPropagation(); ray(event.clientX, event.clientY);
      if (!raycaster.ray.intersectPlane(dragPlane, dragTarget)) return;
      dragTarget.add(dragOffset);
      if (activeTool === "grab") solver.moveGrab(dragTarget.toArray());
      else if (activeTool === "push") {
        const r = interaction.current.probeRadius;
        const depth = THREE.MathUtils.clamp((2 + (event.clientY - startY) * 0.3) * interaction.current.strength, 0, r + 12);
        const horizontalDistance = dragTarget.clone().sub(startPoint).dot(dragRight);
        probeTarget.copy(startPoint).addScaledVector(dragRight, horizontalDistance).addScaledVector(hitNormal, r - depth);
        probeTarget.y = Math.max(probeTarget.y, floorY + r);
        solver.setProbe(probeTarget.toArray(), r);
      }
    };
    const up = (event: PointerEvent) => { if (event.pointerId === activePointer) {
      event.preventDefault(); event.stopPropagation(); const recoil = event.type === "pointerup" ? strike : null;
      if (renderer.domElement.hasPointerCapture(event.pointerId)) renderer.domElement.releasePointerCapture(event.pointerId);
      release(); strike = recoil;
    } };
    const lostCapture = () => { if (activePointer !== null) release(); };
    const leave = () => { hoverPointer = null; lastAim = 0; };
    const keydown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "f") { event.preventDefault(); event.stopPropagation(); fitView(); return; }
      if (event.key === "Enter" || (event.key === "Escape" && keyboardGrab)) { event.preventDefault(); event.stopPropagation(); release(); return; }
      if (event.key.toLowerCase() === "p") { event.preventDefault(); punchCenter(); return; }
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown"].includes(event.key) || interaction.current.paused) return;
      event.preventDefault(); event.stopPropagation();
      if (!keyboardGrab) {
        release(); const hit = centerIntersection(); dragTarget.copy(hit?.point ?? centerHit());
        instrumentAxis.copy(approachAxis(hit ? outwardNormal(hit) : camera.position.clone().sub(dragTarget).normalize()));
        keyboardGrab = solver.beginGrab(dragTarget.toArray(), interaction.current.radius); if (!keyboardGrab) return;
      }
      const direction = new THREE.Vector3();
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") direction.setFromMatrixColumn(camera.matrixWorld, 0).multiplyScalar(event.key === "ArrowLeft" ? -8 : 8);
      else if (event.key === "ArrowUp" || event.key === "ArrowDown") direction.setFromMatrixColumn(camera.matrixWorld, 1).multiplyScalar(event.key === "ArrowDown" ? -8 : 8);
      else camera.getWorldDirection(direction).multiplyScalar(event.key === "PageUp" ? 8 : -8);
      dragTarget.add(direction); solver.moveGrab(dragTarget.toArray());
    };
    const updateInstrument = (now: number, dt: number) => {
      const contact = solver.interactionState();
      if (strike && now - strike.time > 420) strike = null;
      const kind = contact.grab ? "grasper" : strike || interaction.current.tool === "push" || interaction.current.tool === "punch" ? "probe" : "grasper";
      const instrument = kind === "grasper" ? grasper : palpator;
      grasper.group.visible = kind === "grasper" && (interaction.current.tool !== "orbit" || !!contact.grab);
      palpator.group.visible = kind === "probe" && (interaction.current.tool !== "orbit" || !!strike);
      const r = contact.probe?.radiusMm ?? interaction.current.probeRadius;
      palpator.setContactRadius(r);
      instrumentEngaged = !!(contact.grab || contact.probe || strike);
      jawClosure = THREE.MathUtils.damp(jawClosure, contact.grab ? 1 : 0, 28, Math.min(dt, 0.05));
      grasper.setJawClosure(jawClosure);
      if (contact.grab) instrument.group.position.fromArray(contact.grab.handleMm);
      else if (contact.probe) instrument.group.position.fromArray(contact.probe.centerMm).addScaledVector(instrumentAxis, -r);
      else if (strike) {
        instrumentAxis.copy(strike.axis);
        instrument.group.position.copy(strike.point).addScaledVector(instrumentAxis, 24 * Math.min((now - strike.time) / 300, 1));
      } else {
        if (now - lastAim > 120 || lastAim === 0) {
          if (hoverPointer) ray(hoverPointer.x, hoverPointer.y);
          const hit = hoverPointer ? raycaster.intersectObject(organ)[0] : centerIntersection();
          if (hit) rememberAim(hit); else { const fallback = centerIntersection(); if (fallback) rememberAim(fallback); }
          lastAim = now;
        }
        if (hoverAnchor) {
          const point = new THREE.Vector3();
          hoverAnchor.indices.forEach((index, corner) => point.addScaledVector(new THREE.Vector3().fromBufferAttribute(attribute, index), hoverAnchor!.weights.getComponent(corner)));
          instrumentAxis.copy(approachAxis(hoverAnchor.normal));
          instrument.group.position.copy(point).addScaledVector(hoverAnchor.normal, 9);
          instrument.group.position.y = Math.max(instrument.group.position.y, floorY + r);
        }
      }
      pose.setFromUnitVectors(localShaftAxis, instrumentAxis); instrument.group.quaternion.copy(pose);
    };
    const contextMenu = (event: Event) => event.preventDefault();
    renderer.domElement.addEventListener("pointerdown", down, true); renderer.domElement.addEventListener("pointermove", move, true);
    renderer.domElement.addEventListener("pointerleave", leave);
    renderer.domElement.addEventListener("pointerup", up, true); renderer.domElement.addEventListener("pointercancel", up, true);
    renderer.domElement.addEventListener("lostpointercapture", lostCapture); renderer.domElement.addEventListener("keydown", keydown); renderer.domElement.addEventListener("contextmenu", contextMenu);
    const lost = (event: Event) => { event.preventDefault(); setPaused(true); setError("Graphics context lost. Reset the room by reapplying the material."); };
    renderer.domElement.addEventListener("webglcontextlost", lost);
    const nativeRecording = registerSceneRecordingSource({ renderer, camera, host: element, label: "Hands-on liver physics", draw: () => renderer.render(world, camera) });
    let initialSize = true;
    const resize = new ResizeObserver(() => { if (nativeRecording.active || !element.clientWidth || !element.clientHeight) return; renderer.setSize(element.clientWidth, element.clientHeight); camera.aspect = element.clientWidth / element.clientHeight; camera.updateProjectionMatrix(); if (initialSize) { resetView(); initialSize = false; } }); resize.observe(element);
    const recordSample = (now: number) => {
      if (!recording.current?.wantsSample(now)) return;
      recording.current.add({ metrics: solver.metrics(), node_positions_mm: Array.from(solver.positionsMm), camera_position_mm: camera.position.toArray(), camera_target_mm: controls.target.toArray(), camera_fov_degrees: camera.getEffectiveFOV(), camera_aspect: camera.aspect, tool: interaction.current.tool, paused: interaction.current.paused, gravity: interaction.current.gravity, contact: solver.interactionState() }, now);
    };
    runtime.current = { solver, resetView, fitView, release, punchCenter, recordSample };
    let frame = 0; let previous = performance.now(); let lastMetrics = previous; let frameCount = 0; let wallTime = 0; let previousSimulationTime = 0;
    const visibility = () => { previous = performance.now(); };
    document.addEventListener("visibilitychange", visibility);
    const animate = (now: number) => {
      frame = requestAnimationFrame(animate); const dt = Math.max(0, (now - previous) / 1000); previous = now;
      if (document.hidden) return;
      if (!interaction.current.paused) { wallTime += dt; solver.advance(dt); updateSurface(); }
      controls.update(); updateInstrument(now, dt); renderer.render(world, camera); frameCount++;
      recordSample(now);
      if (now - lastMetrics >= 200) {
        updateCapture(); setInFrame(liverInCameraFrame(camera, geometry.boundingBox!));
        const current = solver.metrics(); setMetrics(current); setFps(frameCount * 1000 / (now - lastMetrics));
        if (current.simulation_time_s < previousSimulationTime) wallTime = Math.max(dt, current.simulation_time_s);
        const clockStalled = !interaction.current.paused && wallTime > 1 && current.simulation_time_s <= previousSimulationTime;
        previousSimulationTime = current.simulation_time_s;
        setWallElapsed(wallTime);
        const ratio = current.simulation_time_s / Math.max(wallTime, 0.001); setSpeedRatio(ratio);
        let squaredStrain = 0; let minY = Infinity;
        for (const edge of edges) {
          const length = Math.hypot(solver.positionsMm[edge.a]! - solver.positionsMm[edge.b]!, solver.positionsMm[edge.a + 1]! - solver.positionsMm[edge.b + 1]!, solver.positionsMm[edge.a + 2]! - solver.positionsMm[edge.b + 2]!);
          squaredStrain += ((length - edge.length) / Math.max(edge.length, 0.00001)) ** 2;
        }
        for (let node = 1; node < solver.positionsMm.length; node += 3) minY = Math.min(minY, solver.positionsMm[node]!);
        const strain = Math.sqrt(squaredStrain / Math.max(edges.length, 1)) * 100; setShapeStrain(strain);
        const changedHeight = (geometry.boundingBox!.getSize(new THREE.Vector3()).y / Math.max(extent.y, 0.001) - 1) * 100; setHeightChange(changedHeight);
        const state = interaction.current.paused ? "Paused" : clockStalled ? "Numerical hold" : keyboardGrab || (activePointer !== null && activeTool === "grab") ? "Held" : activePointer !== null && activeTool === "push" ? "Pressed" : minY > floorY + 0.75 ? "Airborne" : current.maximum_speed_m_s < 0.025 ? "Resting on floor" : "Settling";
        setBodyState(state);
        const projected = centerHit().project(camera);
        const canvasRect = renderer.domElement.getBoundingClientRect(), hostRect = element.getBoundingClientRect();
        const visibleInstrument = grasper.group.visible ? grasper : palpator;
        const contact = solver.interactionState();
        if (diagnostics.current) diagnostics.current.dataset.snapshot = JSON.stringify({ metrics: current, wallTimeS: wallTime, simulationSpeedRatio: ratio, rmsEdgeStrainPct: strain, heightChangePct: changedHeight, bodyState: state, nodePositionsMm: Array.from(solver.positionsMm), sourceCenterScreen: { x: canvasRect.left - hostRect.left + (projected.x + 1) * canvasRect.width / 2, y: canvasRect.top - hostRect.top + (1 - projected.y) * canvasRect.height / 2 }, cameraPosition: camera.position.toArray(), cameraTarget: controls.target.toArray(), cameraFovDegrees: camera.getEffectiveFOV(), cameraAspect: camera.aspect, bodyBoundsInFrame: liverInCameraFrame(camera, geometry.boundingBox!), bodyBoundsMm: { min: geometry.boundingBox!.min.toArray(), max: geometry.boundingBox!.max.toArray() }, tool: interaction.current.tool, paused: interaction.current.paused, gravity: interaction.current.gravity, parameters: prepared.parameters, source: prepared.source,
          instrument: { kind: visibleInstrument === grasper ? "grasper" : "probe", visible: visibleInstrument.group.visible, tipMm: visibleInstrument.group.position.toArray(), axis: instrumentAxis.toArray(), jawClosure, contactRadiusMm: contact.probe?.radiusMm ?? interaction.current.probeRadius, engaged: instrumentEngaged, contactModel: contact.grab ? "compliant_patch" : contact.probe ? "sphere" : strike ? "impulse" : "none" }, contact });
        if (!current.finite_state || current.minimum_jacobian <= 0) { setPaused(true); setError("The solver stopped after a numerical failure. Reset the liver before continuing."); }
        lastMetrics = now; frameCount = 0;
      }
    }; frame = requestAnimationFrame(animate);
    return () => {
      nativeRecording.dispose(); recording.current?.stop("scene_changed"); updateCapture();
      cancelAnimationFrame(frame); release(); resize.disconnect(); controls.dispose(); runtime.current = null;
      document.removeEventListener("visibilitychange", visibility);
      renderer.domElement.removeEventListener("pointerdown", down, true); renderer.domElement.removeEventListener("pointermove", move, true); renderer.domElement.removeEventListener("pointerup", up, true); renderer.domElement.removeEventListener("pointercancel", up, true);
      renderer.domElement.removeEventListener("pointerleave", leave);
      renderer.domElement.removeEventListener("lostpointercapture", lostCapture); renderer.domElement.removeEventListener("keydown", keydown); renderer.domElement.removeEventListener("contextmenu", contextMenu); renderer.domElement.removeEventListener("webglcontextlost", lost);
      world.remove(grasper.group, palpator.group); grasper.dispose(); palpator.dispose();
      world.traverse(child => { if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments || child instanceof THREE.Line) child.geometry.dispose(); });
      for (const item of [material, floorMaterial, wallMaterial, gridMaterial]) item.dispose();
      environment.dispose(); renderer.dispose(); renderer.domElement.remove();
    };
  }, [prepared, props.generation]);

  useEffect(() => { runtime.current?.solver.setGravity(gravity); }, [gravity]);
  useEffect(() => { runtime.current?.release(); }, [tool, paused]);

  return <div className="physics-playground">
    <div className="playground-toolbar"><div className="playground-tools" role="group" aria-label="Hands-on tool">{tools.map(item => <button key={item.id} aria-pressed={tool === item.id} onClick={() => setTool(item.id)}><item.icon size={15} />{item.label}</button>)}</div><span className="playground-live-badge"><i className={paused ? "paused" : ""} />{paused ? "PAUSED" : "LIVE PHYSICS"}</span></div>
    <div className="playground-stage"><SceneResizeHandle panel={false} />
      <div ref={host} className="playground-canvas" data-testid="physics-playground-viewport" />
      <div className="playground-room-label"><span>SOFT TISSUE / FREE BODY</span><small>Floor · gravity · direct contact</small></div>
      {prepared && <div className="playground-body-state"><strong>{bodyState}</strong><small>Height change {heightChange > 0 ? "+" : ""}{fmt(heightChange, 1)}%</small></div>}
      {prepared && tool !== "orbit" && <div className="playground-instrument-label"><span>{tool === "grab" ? "Fenestrated grasper" : "Blunt palpator"}</span><small>{tool === "grab" ? "5 mm shaft · articulated jaws" : `Ø${probeRadius * 2} mm tip · ${tool === "punch" ? "impulse" : "contact"}`}</small></div>}
      <div className="playground-view-actions"><button className="atlas-btn" onClick={() => runtime.current?.fitView()} disabled={!prepared} title="Frame the current liver without resetting it (F)"><Maximize size={12} />Fit liver</button><button className="atlas-btn" onClick={() => { mark("reset_room_view"); runtime.current?.resetView(); }} disabled={!prepared}>Reset room view</button></div>
      {prepared && !inFrame && <span className="playground-view-hint">Press F to bring the liver into view</span>}
      {loading && <div className="playground-loading" role="status"><LoaderCircle size={25} className="atlas-spinning" /><strong>{retrying ? "Physics service is busy" : "Preparing your liver"}</strong><span>{retrying ? "Retrying automatically as the current preparation finishes…" : "Binding the displayed mesh to interactive physics…"}</span></div>}
      {!loading && !prepared && <div className="playground-loading"><Hand size={28} /><strong>The room is ready for a liver</strong><span>Choose valid material parameters, then apply them.</span></div>}
      <div className="playground-ground-label">{gravity ? "9.81 m/s²" : "Gravity off"} · floor at 0 mm</div>
      <div className="playground-camera-hint">Right drag / scroll · Touch camera: Orbit tool</div>
    </div>
    <p className="playground-instruction"><Hand size={15} /><span>{instructions[tool]}</span></p>
    <div className="playground-actions">
      <button className="atlas-btn" onClick={() => { mark(paused ? "resume" : "pause"); setPaused(!paused); }} disabled={!prepared}>{paused ? <Play size={14} /> : <Pause size={14} />}{paused ? "Resume physics" : "Pause physics"}</button>
      <button className="atlas-btn" onClick={() => { mark("reset_liver", true); runtime.current?.release(); runtime.current?.solver.reset(); setPaused(false); setError(""); }} disabled={!prepared}><RotateCcw size={14} />Reset liver</button>
      <button className="atlas-btn" onClick={() => { mark("lift_and_drop", true); runtime.current?.release(); runtime.current?.solver.drop(150); setPaused(false); }} disabled={!prepared}>Lift & drop</button>
      <button className="atlas-btn" aria-pressed={gravity} onClick={() => { mark(gravity ? "gravity_off" : "gravity_on"); setGravity(!gravity); }} disabled={!prepared}>Gravity</button>
      <button className="atlas-btn" onClick={() => { mark("punch_button"); runtime.current?.punchCenter(); }} disabled={!prepared || paused}><Zap size={14} />Punch liver</button>
    </div>
    <div className="playground-tool-settings"><label><span>{tool === "push" ? "Probe radius" : "Tissue influence radius"} <output>{tool === "push" ? probeRadius : radius} mm</output></span><input aria-label={tool === "push" ? "Probe radius" : "Tool radius"} type="range" min={tool === "push" ? 6 : 10} max={tool === "push" ? 12 : 55} step="1" value={tool === "push" ? probeRadius : radius} disabled={tool === "orbit"} onChange={event => { runtime.current?.release(); if (tool === "push") setProbeRadius(Number(event.target.value)); else setRadius(Number(event.target.value)); }} /></label><label><span>Tool strength <output>{fmt(strength)} {tool === "punch" ? "m/s" : "×"}</output></span><input aria-label="Tool strength" title="Punch impulse speed and push depth multiplier" type="range" min="0.15" max="1.5" step="0.05" value={strength} disabled={tool === "grab" || tool === "orbit"} onChange={event => setStrength(Number(event.target.value))} /></label></div>
    <div ref={diagnostics} data-testid="playground-diagnostics" className="playground-metrics" aria-label="Live physics diagnostics">
      <div><span>Material stiffness</span><strong>{prepared ? fmt(prepared.parameters.young_pa / 1000, 2) : "—"}<small> kPa</small></strong><em>{prepared?.learning.source === "learned" ? "Physics network" : "Manual material"}</em></div>
      <div><span>Shape strain</span><strong>{metrics ? fmt(shapeStrain) : "—"}<small> %</small></strong><em>Volume {metrics ? fmt(metrics.volume_change_pct) : "—"}%</em></div>
      <div><span>Floor penetration</span><strong>{metrics ? fmt(metrics.floor_penetration_mm, 3) : "—"}<small> mm</small></strong><em>{metrics?.rejected_steps ?? 0} rejected · {metrics?.limited_steps ?? 0} limited steps</em></div>
      <div><span>Render rate</span><strong>{Math.round(fps)}<small> fps</small></strong><em>Physics {fmt(speedRatio)}× wall time</em></div>
    </div>
    {metrics && tool === "push" && <div className="playground-contact-measurements" data-testid="probe-contact-measurements" aria-label="Probe contact measurements"><div><span>Probe reaction</span><strong>{fmt(Math.hypot(...metrics.probe_reaction_n), 3)} N</strong></div><div><span>Probe overlap</span><strong>{fmt(metrics.maximum_probe_surface_penetration_mm, 3)} mm</strong></div><div><span>Signed probe work</span><strong>{fmt(metrics.probe_work_j * 1000, 3)} mJ</strong></div><p>Computed contact measurements. Work covers tool motion since reset; contact creation and removal are recorded separately.</p></div>}
    {metrics && <p className="playground-solver-note">{metrics.material_model === "continuum" ? "Continuum material" : "Legacy edge material"} · {Math.round(1 / metrics.fixed_step_s)} Hz · minimum J {fmt(metrics.minimum_jacobian, 3)} · {fmt(metrics.mean_step_ms)} ms/step · {fmt(metrics.dropped_time_s)} s dropped · {fmt(metrics.rejected_time_s)} s rejected. {metrics.material_model === "continuum" ? <>Last correction {fmt(metrics.final_sweep_max_displacement_mm, 4)} mm · {metrics.continuum_volume_limits} volume limits · {metrics.rejected_vertex_updates} rejected vertex updates.</> : <>{metrics.minimum_volume_projections} volume guard projections.</>} Shape strain measures edge-length change, excluding rigid translation.</p>}
    {metrics && speedRatio < 0.5 && wallElapsed > 1 && <p className="playground-timing-warning" role="status">{bodyState === "Numerical hold" ? "Physics steps are being rejected. Reset the liver to recover." : "Physics is advancing slower than wall time. Render rate does not measure simulation speed."}</p>}
    {error && <div className="playground-error" role="alert"><p>{error}</p><button className="atlas-btn" onClick={() => { loadedKey.current = ""; setRetry(value => value + 1); }}>Retry interactive scene</button></div>}
    <div className="playground-capture"><div className="playground-capture-actions"><button className="atlas-btn" onClick={toggleRecording} disabled={!prepared} aria-pressed={capture.active}>{capture.active ? <Square size={12} /> : <Circle size={12} />}{capture.active ? "Stop recording" : "Record motion"}</button><button className="atlas-btn" onClick={downloadMotion} disabled={!capture.count}><Download size={13} />Download motion JSON</button></div><p role="status">{capture.count ? <>{capture.active ? "Recording" : "Saved"} · {capture.count} samples{capture.reason === "sample_limit" ? " · capture limit reached" : capture.reason === "scene_changed" ? " · previous material / scene" : capture.reason === "invalid_state" ? " · stopped at invalid state" : ""}</> : "Record deformation, tool contact and camera pose for comparison."}<small>Up to 30 samples/s with actual timestamps. Short impacts may fall between samples.</small></p></div>
    <details className="playground-notes"><summary>Keyboard controls & physics model</summary><p>Focus the 3D view. Arrow keys grab the front surface and move it in the camera plane; Page Up / Down moves in depth. Enter releases; P punches; F frames the current liver without resetting it. Use the buttons to pause, reset or drop.</p><p>The grasper uses a compliant tissue attachment; the palpator uses its visible spherical tip for contact. Jaws and shafts are visual geometry, without separate collision. Punch applies a local impulse. Tissue influence radius controls the affected patch, not shaft size. Cutting is available in Recorded experiments.</p><p>The continuum model uses finite-strain tissue elasticity and material relaxation, with gravity and a floor. Its material equations match the recorded solver, but the browser uses a fixed iteration budget for interaction. The last correction measures solver progress, not equilibrium convergence. Volume limits and line searches protect the numerical solve. Probe contact reports remaining overlap; tool movement is bounded and deep initial placement is adjusted to the cage boundary. Floor friction uses an estimated support reaction. Its coefficient and extra damping are prescribed assumptions; contact-force accuracy still depends on step size and iteration count. This is not a validated surgical simulator.</p>{prepared?.limitations.map((item, index) => <p key={index}>{item}</p>)}</details>
  </div>;
}
