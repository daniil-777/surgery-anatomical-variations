import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { fitLiverView } from "../liverPlaygroundView";
import { registerSceneRecordingSource } from "../sceneRecordingSource";
import type { CuttingReference } from "./types";
import { createCuttingSurfaceMaterial, createCuttingReflectionEnvironment, createCuttingDrapeMaterial, CUTTING_LIGHTING } from "./appearance";
import { createLaparoscopicScissors, LAPAROSCOPIC_SCISSORS_DIMENSIONS } from "./laparoscopicScissors";
import { ScissorsSurfaceEngine } from "./scissorsSurface";
import { ScissorsClock } from "./scissorsClock";

export type ScissorsMode = "place" | "translate" | "rotate" | "orbit";
export interface ScissorsState {
  ready: boolean; busy: boolean; mode: ScissorsMode; opening: number; fps: number;
  position: [number, number, number]; rotation: [number, number, number];
  cutCount: number; cutSegments: number; maximumDisplacementMm: number; maximumLipOpeningMm: number;
  notice: string;
}
const rad = THREE.MathUtils.degToRad, deg = THREE.MathUtils.radToDeg;
const { maximumOpeningRadians: APERTURE, jawLengthMm: JAW_LENGTH, activeStartMm: ACTIVE_START } = LAPAROSCOPIC_SCISSORS_DIMENSIONS;

/** Responsive surface-incision workspace. Its topology and compliant shell are
 * deliberately separate from the fixed-plane volumetric calibration experiment. */
export function createScissorsScene(host: HTMLElement, reference: CuttingReference, publish: (state: ScissorsState) => void, fail: (message: string) => void) {
  const initializationCleanup: (() => void)[] = [];
  try {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance", preserveDrawingBuffer: true });
  initializationCleanup.push(() => renderer.dispose());
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.75));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = .95;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const canvas = renderer.domElement; canvas.tabIndex = 0;
  canvas.setAttribute("aria-label", "3D scissors scene. Place mode: click or tap tissue. M moves, R rotates, V orbits. Arrow keys move X and Y, Page Up or Down moves Z; in Rotate mode these keys rotate. Space closes scissors and cuts. F fits the liver.");
  host.appendChild(canvas);
  initializationCleanup.push(() => { canvas.remove(); delete host.dataset.scissorsDiagnostics; });
  const engine = new ScissorsSurfaceEngine(reference.skin);
  const clock = new ScissorsClock();
  const scene = new THREE.Scene(); scene.background = new THREE.Color(CUTTING_LIGHTING.background);
  initializationCleanup.push(() => {
    const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>();
    scene.traverse(object => { if (object instanceof THREE.Mesh) { geometries.add(object.geometry); for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material); } });
    geometries.forEach(item => item.dispose()); materials.forEach(item => item.dispose()); scene.clear();
  });
  const camera = new THREE.PerspectiveCamera(36, 1, .1, 2500);
  const orbit = new OrbitControls(camera, canvas); orbit.enableDamping = true;
  initializationCleanup.push(() => orbit.dispose());
  orbit.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
  const pmrem = new THREE.PMREMGenerator(renderer), room = createCuttingReflectionEnvironment();
  initializationCleanup.push(() => { room.dispose(); pmrem.dispose(); });
  const environment = pmrem.fromScene(room.scene, .015, .1, 1000); room.dispose(); pmrem.dispose(); scene.environment = environment.texture;
  initializationCleanup.push(() => environment.dispose());
  scene.add(new THREE.HemisphereLight(CUTTING_LIGHTING.hemisphere.sky, CUTTING_LIGHTING.hemisphere.ground, .8));
  const light = new THREE.DirectionalLight("#fff7ee", 2.1); light.position.set(-150, 350, 260); light.castShadow = true;
  light.shadow.mapSize.set(2048, 2048); Object.assign(light.shadow.camera, { left: -270, right: 270, top: 260, bottom: -260, near: 1, far: 1000 }); light.shadow.normalBias = .2; scene.add(light);
  const fill = new THREE.DirectionalLight("#d9e3e8", .45); fill.position.set(220, 80, -180); scene.add(fill);
  const scopeLight = new THREE.DirectionalLight("#fff5ea", .78); scene.add(scopeLight); scene.add(scopeLight.target);
  const floorGeometry = new THREE.PlaneGeometry(900, 900), floorMaterial = createCuttingDrapeMaterial();
  const floor = new THREE.Mesh(floorGeometry, floorMaterial); floor.rotation.x = -Math.PI / 2; floor.position.y = reference.floorYMm; floor.receiveShadow = true; scene.add(floor);
  let skin: THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>;
  let walls: THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>;
  let geometryRevision = -1, positionRevision = -1;
  function smoothWallNormals(geometry: THREE.BufferGeometry) {
    geometry.computeVertexNormals();
    const pos = geometry.getAttribute("position"), norm = geometry.getAttribute("normal");
    if (!pos || !norm || pos.count === 0) return;
    const wallStart = engine.metrics().nodeCount;
    for (let base = wallStart; base + 3 < pos.count; base += 4) {
      let qx = 0, qy = 0, qz = 0;
      for (let j = 0; j < 4; j++) { qx += norm.getX(base + j); qy += norm.getY(base + j); qz += norm.getZ(base + j); }
      const qLen = Math.hypot(qx, qy, qz);
      if (qLen > 1e-6) {
        qx /= qLen; qy /= qLen; qz /= qLen;
        for (let j = 0; j < 4; j++) norm.setXYZ(base + j, qx, qy, qz);
      }
    }
    const topGroups = new Map<string, number[]>();
    for (let base = wallStart; base + 3 < pos.count; base += 4) {
      for (const j of [0, 1]) {
        const i = base + j;
        const key = `${Math.round(pos.getX(i) * 50)},${Math.round(pos.getY(i) * 50)},${Math.round(pos.getZ(i) * 50)}`;
        const list = topGroups.get(key) ?? []; list.push(i); topGroups.set(key, list);
      }
    }
    for (let pass = 0; pass < 4; pass++) {
      for (const list of topGroups.values()) {
        if (list.length < 2) continue;
        for (const i of list) {
          const refX = norm.getX(i), refY = norm.getY(i), refZ = norm.getZ(i);
          let sx = refX, sy = refY, sz = refZ;
          for (const j of list) {
            if (i === j) continue;
            const nx = norm.getX(j), ny = norm.getY(j), nz = norm.getZ(j);
            if (refX * nx + refY * ny + refZ * nz > .35) { sx += nx; sy += ny; sz += nz; }
          }
          const len = Math.hypot(sx, sy, sz);
          if (len > 1e-6) norm.setXYZ(i, sx / len, sy / len, sz / len);
        }
      }
      for (let base = wallStart; base + 3 < pos.count; base += 4) {
        const ax = norm.getX(base), ay = norm.getY(base), az = norm.getZ(base);
        const bx = norm.getX(base + 1), by = norm.getY(base + 1), bz = norm.getZ(base + 1);
        if (pass < 3) {
          const mx = ax + bx, my = ay + by, mz = az + bz, mLen = Math.hypot(mx, my, mz) || 1;
          const nax = .7 * ax + .3 * (mx / mLen), nay = .7 * ay + .3 * (my / mLen), naz = .7 * az + .3 * (mz / mLen), naLen = Math.hypot(nax, nay, naz) || 1;
          const nbx = .7 * bx + .3 * (mx / mLen), nby = .7 * by + .3 * (my / mLen), nbz = .7 * bz + .3 * (mz / mLen), nbLen = Math.hypot(nbx, nby, nbz) || 1;
          norm.setXYZ(base, nax / naLen, nay / naLen, naz / naLen);
          norm.setXYZ(base + 1, nbx / nbLen, nby / nbLen, nbz / nbLen);
        }
        norm.setXYZ(base + 3, norm.getX(base), norm.getY(base), norm.getZ(base));
        norm.setXYZ(base + 2, norm.getX(base + 1), norm.getY(base + 1), norm.getZ(base + 1));
      }
    }
    norm.needsUpdate = true;
  }
  function replaceSurface() {
    const view = engine.geometry();
    const make = (indices: Uint32Array, surface: "capsule" | "cut") => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(view.positionsMm, 3).setUsage(THREE.DynamicDrawUsage));
      geometry.setIndex(new THREE.BufferAttribute(indices, 1));
      if (surface === "cut") smoothWallNormals(geometry); else geometry.computeVertexNormals();
      geometry.computeBoundingSphere();
      const material = createCuttingSurfaceMaterial(geometry, view.restPositionsMm, surface);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = surface === "capsule"; mesh.receiveShadow = surface === "capsule";
      mesh.name = surface === "capsule" ? "scissors-cuttable-liver-surface" : "scissors-incision-interior";
      scene.add(mesh); return mesh;
    };
    for (const mesh of [skin, walls]) if (mesh) { scene.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose(); }
    skin = make(view.indices, "capsule"); walls = make(view.wallIndices, "cut");
    geometryRevision = view.revision; positionRevision = view.positionRevision;
  }
  replaceSurface(); skin!.geometry.computeBoundingBox();
  const bounds = skin!.geometry.boundingBox!.clone();
  const instrument = createLaparoscopicScissors(); scene.add(instrument.group); instrument.setOpening(1);
  const transform = new TransformControls(camera, canvas); transform.attach(instrument.group); transform.setSize(.75); transform.setSpace("world"); scene.add(transform.getHelper());
  initializationCleanup.push(() => transform.dispose());
  const markerGeometry = new THREE.TorusGeometry(3, .15, 6, 40), markerMaterial = new THREE.MeshBasicMaterial({ color: "#bbe9cc", depthTest: false, transparent: true, opacity: .8 });
  const marker = new THREE.Mesh(markerGeometry, markerMaterial); marker.renderOrder = 100; scene.add(marker);
  let mode: ScissorsMode = "place", busy = false, opening = 1, depth = 2, disposed = false, failed = false;
  const seatOffset = (d = depth) => .3 * d;
  let showPlacementMarker = true;
  const placedSurfaceNormal = new THREE.Vector3(0, 1, 0);
  let notice = "Jaws are ready. Click or drag on the liver to place them, then press Close & cut.";
  let cycle: { start: number; applied: boolean } | null = null;
  let fps = 0, frameCount = 0, fpsStart = performance.now(), lastPublish = 0, previous = performance.now(), animation = 0;
  const raycaster = new THREE.Raycaster();
  const pose = () => ({ positionMm: instrument.group.position.toArray() as [number, number, number], quaternion: instrument.group.quaternion.toArray() as [number, number, number, number] });
  const state = (): ScissorsState => ({ ready: !failed && !disposed, busy, mode, opening, fps, position: pose().positionMm,
    rotation: new THREE.Euler().setFromQuaternion(instrument.group.quaternion, "XYZ").toArray().slice(0, 3).map(value => deg(Number(value))) as [number, number, number],
    ...engine.metrics(), notice });
  function notify() { const next = state(); host.dataset.scissorsDiagnostics = JSON.stringify({ ...next, geometryRevision, ...engine.metrics() }); publish(next); }
  function updateMode() {
    transform.enabled = !busy && !failed && (mode === "translate" || mode === "rotate");
    transform.getHelper().visible = transform.enabled;
    transform.setMode(mode === "rotate" ? "rotate" : "translate");
    orbit.enabled = !transform.dragging && !failed;
    // Reserve primary touch/mouse for surface placement; right drag and wheel
    // remain available. TransformControls arbitrates its own handles.
    orbit.mouseButtons.LEFT = mode === "place" ? undefined as unknown as THREE.MOUSE : THREE.MOUSE.ROTATE;
    orbit.touches.ONE = mode === "place" ? undefined as unknown as THREE.TOUCH : THREE.TOUCH.ROTATE;
    canvas.style.cursor = mode === "place" ? "crosshair" : "grab";
  }
  const changePose = () => {
    showPlacementMarker = true;
    instrument.group.position.clamp(bounds.min.clone().addScalar(-160), bounds.max.clone().addScalar(160));
    instrument.group.updateMatrixWorld(true); updateMarker(); notify();
  };
  transform.addEventListener("dragging-changed", () => { orbit.enabled = !transform.dragging; });
  transform.addEventListener("objectChange", changePose);
  const endTransformDrag = () => { transform.pointerUp(null); orbit.enabled = !failed; };
  function updateMarker() {
    marker.position.set(0, seatOffset(), 10).applyMatrix4(instrument.group.matrixWorld);
    marker.quaternion.copy(instrument.group.quaternion).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2));
    marker.visible = showPlacementMarker && !busy && mode === "place";
  }
  function place(point: THREE.Vector3, surfaceNormal: THREE.Vector3, forward?: THREE.Vector3) {
    if (busy || failed) return;
    const y = surfaceNormal.clone().normalize();
    placedSurfaceNormal.copy(y);
    const z = (forward?.clone() ?? new THREE.Vector3(0, 0, 1)).projectOnPlane(y);
    if (z.lengthSq() < .01) z.set(1, 0, 0).addScaledVector(y, -y.x);
    z.normalize();
    // A shallow surgical tangency keeps the shaft above proximal tissue while
    // seating the full 15.5 mm active blade span across the capsule surface.
    const normal = y.clone(), approach = rad(8);
    y.multiplyScalar(Math.cos(approach)).addScaledVector(z, Math.sin(approach));
    z.multiplyScalar(Math.cos(approach)).addScaledVector(normal, -Math.sin(approach));
    const x = y.clone().cross(z).normalize(); z.copy(x).cross(y).normalize();
    instrument.group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
    instrument.group.position.copy(point).addScaledVector(z, -10).addScaledVector(y, -seatOffset());
    notice = "Tissue positioned between the jaws. Press Close & cut; moving the tool alone never cuts."; changePose();
  }
  function placeDefault() {
    const center = bounds.getCenter(new THREE.Vector3());
    // Seat the default incision on the broad, convex right lobe dome away from
    // the central vena cava opening so both jaws capture a full tangential bite.
    for (const fraction of [-.25, -.2, .25, .2, .35, -.35, 0]) {
      raycaster.set(new THREE.Vector3(center.x + bounds.getSize(new THREE.Vector3()).x * fraction, bounds.max.y + 100, center.z), new THREE.Vector3(0, -1, 0));
      const hit = raycaster.intersectObject(skin!, false)[0];
      if (hit?.face && hit.face.normal.y > .2) { place(hit.point, hit.face.normal); return; }
    }
    instrument.group.position.copy(center).add(new THREE.Vector3(0, bounds.max.y + 20, 0));
    notice = "Select Place on liver and click a visible surface to position the jaws."; changePose();
  }
  function fit() {
    const wasDamping = orbit.enableDamping; orbit.enableDamping = false; orbit.update();
    orbit.target.copy(fitLiverView(camera, bounds, 1.12)); orbit.update(); orbit.enableDamping = wasDamping;
  }
  function focus() {
    instrument.group.updateMatrixWorld(true);
    const center = new THREE.Vector3(0, seatOffset(), 10).applyMatrix4(instrument.group.matrixWorld);
    // View across the hinge axis so both articulated blades and the incision
    // remain readable even after arbitrary instrument rotation.
    const back = new THREE.Vector3(.9, 1.2, 1.1).applyQuaternion(instrument.group.quaternion).normalize();
    orbit.target.copy(center); camera.position.copy(center).addScaledVector(back, 145); orbit.update();
  }
  function cut() {
    if (busy || failed || disposed) return false;
    if (transform.dragging) { notice = "Release the transform handle before closing the jaws."; notify(); return false; }
    showPlacementMarker = false;
    cycle = { start: performance.now(), applied: false }; busy = true;
    notice = "Closing jaws…"; updateMode(); updateMarker(); notify(); return true;
  }
  function reset() {
    endTransformDrag();
    cycle = null; busy = false; opening = 1; engine.reset(); clock.reset(); replaceSurface(); instrument.setOpening(1);
    notice = "Intact liver restored. Position the jaws and press Close & cut."; placeDefault(); updateMode(); notify();
  }
  function setMode(next: ScissorsMode) { if (busy || failed) return; endTransformDrag(); mode = next; updateMode(); updateMarker(); notify(); }
  function raycastLiver(clientX: number, clientY: number) {
    const rectangle = canvas.getBoundingClientRect();
    if (rectangle.width <= 0 || rectangle.height <= 0) return null;
    raycaster.setFromCamera(new THREE.Vector2((clientX - rectangle.left) / rectangle.width * 2 - 1, -(clientY - rectangle.top) / rectangle.height * 2 + 1), camera);
    const hit = raycaster.intersectObject(skin!, false)[0];
    if (!hit?.face) return null;
    const normal = hit.face.normal.clone();
    const normAttr = skin!.geometry.getAttribute("normal");
    if (normAttr) {
      const na = new THREE.Vector3().fromBufferAttribute(normAttr, hit.face.a);
      const nb = new THREE.Vector3().fromBufferAttribute(normAttr, hit.face.b);
      const nc = new THREE.Vector3().fromBufferAttribute(normAttr, hit.face.c);
      const smooth = na.add(nb).add(nc);
      if (smooth.lengthSq() > 1e-6) normal.copy(smooth.normalize());
    }
    if (normal.dot(raycaster.ray.direction) > 0) normal.negate();
    return { point: hit.point, normal };
  }
  let pendingTap: { id: number; x: number; y: number; dragged: boolean; lastPoint: THREE.Vector3 | null; forward: THREE.Vector3 | null } | null = null;
  const touches = new Set<number>();
  const pointerDown = (event: PointerEvent) => {
    if (event.pointerType === "touch") touches.add(event.pointerId);
    if (!event.isPrimary || touches.size > 1) { pendingTap = null; return; }
    if (event.button !== 0 || mode !== "place" || busy || failed) return;
    pendingTap = { id: event.pointerId, x: event.clientX, y: event.clientY, dragged: false, lastPoint: null, forward: null };
    canvas.focus({ preventScroll: true });
  };
  const pointerMove = (event: PointerEvent) => {
    if (!pendingTap || pendingTap.id !== event.pointerId) return;
    if (touches.size > 1 || busy || failed || mode !== "place") { pendingTap = null; return; }
    if (!pendingTap.dragged && Math.hypot(event.clientX - pendingTap.x, event.clientY - pendingTap.y) <= 5) return;
    pendingTap.dragged = true;
    const hit = raycastLiver(event.clientX, event.clientY);
    if (!hit) return;
    if (pendingTap.lastPoint) {
      const delta = hit.point.clone().sub(pendingTap.lastPoint).projectOnPlane(hit.normal);
      if (delta.lengthSq() > 2.25) {
        delta.normalize();
        pendingTap.forward = pendingTap.forward ? pendingTap.forward.lerp(delta, .35).normalize() : delta;
        pendingTap.lastPoint.copy(hit.point);
      }
    } else pendingTap.lastPoint = hit.point.clone();
    place(hit.point, hit.normal, pendingTap.forward ?? undefined);
  };
  const pointerUp = (event: PointerEvent) => {
    touches.delete(event.pointerId);
    if (pendingTap?.id !== event.pointerId) return;
    const tap = pendingTap;
    pendingTap = null;
    if (busy || failed || mode !== "place") return;
    const hit = raycastLiver(event.clientX, event.clientY);
    if (hit) place(hit.point, hit.normal, tap.forward ?? undefined);
    else if (!tap.dragged) { notice = "No tissue under the pointer. Click or tap the liver surface to place the jaws."; notify(); }
  };
  const pointerCancel = (event: PointerEvent) => { pendingTap = null; touches.delete(event.pointerId); endTransformDrag(); };
  function advance() {
    if (busy || failed) return;
    // Keep the advancing blade plane coplanar with the active incision while
    // re-seating the jaws onto the curved surface 10 mm ahead.
    instrument.group.updateMatrixWorld(true);
    const currentX = new THREE.Vector3(1, 0, 0).applyQuaternion(instrument.group.quaternion);
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(instrument.group.quaternion).projectOnPlane(placedSurfaceNormal);
    if (forward.lengthSq() < .01) { notice = "Aim along the surface before advancing, or place the jaws at the next point."; notify(); return; }
    forward.normalize();
    const next = new THREE.Vector3(0, seatOffset(), 10).applyMatrix4(instrument.group.matrixWorld).addScaledVector(forward, 10);
    raycaster.set(next.clone().addScaledVector(placedSurfaceNormal, 30), placedSurfaceNormal.clone().negate());
    const hit = raycaster.intersectObject(skin!, false)[0];
    if (!hit?.face || hit.distance > 50 || hit.face.normal.dot(placedSurfaceNormal) < .2) { notice = "No reachable tissue at the next bite. Click or tap another point with Place on liver."; notify(); return; }
    const normal = hit.face.normal.clone().projectOnPlane(currentX);
    if (normal.lengthSq() < .01) normal.copy(placedSurfaceNormal); else normal.normalize();
    const point = hit.point.clone().addScaledVector(currentX, -hit.point.clone().sub(instrument.group.position).dot(currentX));
    place(point, normal, forward);
    notice = "Jaws re-seated on tissue 10 mm ahead. Press Close & cut to extend the incision."; notify();
  }
  const keyDown = (event: KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.repeat) return;
    const key = event.key.toLowerCase();
    if ([" ", "enter", "c", "a", "escape", "f", "m", "r", "v", "p", "arrowup", "arrowdown", "arrowleft", "arrowright", "pageup", "pagedown"].includes(key)) { event.preventDefault(); event.stopPropagation(); } else return;
    if (key === "escape") { endTransformDrag(); return; }
    if (key === " " || key === "enter" || key === "c") { cut(); return; }
    if (key === "a") { advance(); return; }
    if (key === "f") { fit(); return; }
    if (busy || failed) return;
    if (["m", "r", "v", "p"].includes(key)) { setMode(({ m: "translate", r: "rotate", v: "orbit", p: "place" } as const)[key as "m"]); return; }
    const axis = key === "arrowleft" || key === "arrowright" ? 0 : key === "pageup" || key === "pagedown" ? 2 : 1;
    const sign = key === "arrowleft" || key === "arrowdown" || key === "pagedown" ? -1 : 1;
    if (mode === "rotate") { const vector = new THREE.Vector3().setComponent(axis, 1); instrument.group.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(vector, rad(sign * (event.shiftKey ? 15 : 5)))); }
    else instrument.group.position.setComponent(axis, instrument.group.position.getComponent(axis) + sign * (event.shiftKey ? 5 : 1));
    changePose();
  };
  canvas.addEventListener("pointerdown", pointerDown); canvas.addEventListener("pointermove", pointerMove); canvas.addEventListener("pointerup", pointerUp, true); canvas.addEventListener("keydown", keyDown);
  canvas.addEventListener("pointercancel", pointerCancel); canvas.addEventListener("lostpointercapture", pointerCancel); canvas.addEventListener("blur", endTransformDrag);
  const visibility = () => {
    previous = performance.now();
    if (document.hidden) { pendingTap = null; touches.clear(); endTransformDrag(); }
    if (!document.hidden || !cycle) return;
    engine.setToolInteraction(null);
    notice = cycle.applied ? "Incision preserved. Jaws reopened when the tab was hidden." : "Jaw closure cancelled when the tab was hidden. Press Close & cut when ready.";
    cycle = null; busy = false; opening = 1; instrument.setOpening(1); updateMode(); updateMarker(); notify();
  };
  document.addEventListener("visibilitychange", visibility);
  initializationCleanup.push(() => document.removeEventListener("visibilitychange", visibility));
  const lost = (event: Event) => { event.preventDefault(); failed = true; busy = false; cycle = null; updateMode(); notify(); fail("The graphics context was lost. Reload this experiment to restore the scene."); };
  canvas.addEventListener("webglcontextlost", lost);
  const draw = () => {
    scopeLight.position.copy(camera.position);
    scopeLight.target.position.copy(orbit.target);
    scopeLight.target.updateMatrixWorld();
    renderer.render(scene, camera);
  };
  const recording = registerSceneRecordingSource({ renderer, camera, host, label: "Laparoscopic scissors · interactive surface model", draw, available: () => !disposed && !failed });
  initializationCleanup.push(() => recording.dispose());
  const resize = () => { if (recording.active || disposed) return; const width = Math.max(1, host.clientWidth), height = Math.max(1, host.clientHeight); renderer.setSize(width, height); camera.aspect = width / height; camera.updateProjectionMatrix(); };
  const observer = new ResizeObserver(resize); observer.observe(host); resize();
  initializationCleanup.push(() => observer.disconnect());
  camera.position.set(190, 230, 270); camera.lookAt(bounds.getCenter(new THREE.Vector3())); camera.updateMatrixWorld(); fit(); placeDefault(); updateMode();
  const tick = (now: number) => {
    if (disposed) return; animation = requestAnimationFrame(tick);
    // A first rAF timestamp can precede initialization's performance.now()
    // within the same browser frame. Never submit negative physical time.
    const dt = Math.max(0, (now - previous) / 1000); previous = now;
    if (failed || document.hidden) return;
    try {
      if (cycle) {
        const elapsed = (now - cycle.start) / 1000;
        opening = elapsed < .4 ? 1 - elapsed / .4 : elapsed < .58 ? 0 : Math.min(1, (elapsed - .58) / .35);
        instrument.setOpening(opening);
        if (elapsed < .4) {
          engine.setToolInteraction({ ...pose(), openingRadians: APERTURE * opening, lengthMm: JAW_LENGTH, activeStartMm: ACTIVE_START, insertionDepthMm: depth, phase: "closing", intensity: Math.sin(Math.min(1, elapsed / .4) * Math.PI * .5) });
        }
        if (elapsed >= .4 && !cycle.applied) {
          cycle.applied = true;
          const result = engine.snip({ ...pose(), openingRadians: APERTURE, closingRadians: 0, lengthMm: JAW_LENGTH, activeStartMm: ACTIVE_START, depthMm: Math.max(4, depth * 2) });
          notice = result.changed ? `Incision made · ${result.cutSegments} surface segments separated. Advance along the cut or place the jaws elsewhere.`
            : result.reason === "already-cut" ? "This jaw position has already been cut. Advance 10 mm or choose another surface point."
            : "No new tissue caught between the jaws. Use Place on liver, or adjust the tool position and angle.";
        }
        if (elapsed >= .4 && elapsed < .93) {
          const unload = Math.max(0, 1 - (elapsed - .4) / .53);
          engine.setToolInteraction({ ...pose(), openingRadians: APERTURE * opening, lengthMm: JAW_LENGTH, activeStartMm: ACTIVE_START, insertionDepthMm: depth, phase: "opening", intensity: unload });
        }
        if (elapsed >= .93) { engine.setToolInteraction(null); cycle = null; busy = false; opening = 1; instrument.setOpening(1); updateMode(); updateMarker(); notify(); }
      }
      clock.advance(dt, step => engine.step(step));
      const view = engine.geometry();
      if (view.revision !== geometryRevision) replaceSurface();
      else if (view.positionRevision !== positionRevision) {
        skin!.geometry.getAttribute("position").needsUpdate = true; skin!.geometry.computeVertexNormals(); skin!.geometry.computeBoundingSphere();
        walls!.geometry.getAttribute("position").needsUpdate = true; smoothWallNormals(walls!.geometry); walls!.geometry.computeBoundingSphere();
        positionRevision = view.positionRevision;
      }
      orbit.update(); draw(); frameCount++;
      if (now - fpsStart >= 1000) { fps = frameCount * 1000 / (now - fpsStart); fpsStart = now; frameCount = 0; }
      if (now - lastPublish > 150) { notify(); lastPublish = now; }
    } catch (error) { failed = true; busy = false; cycle = null; updateMode(); notify(); fail(error instanceof Error ? error.message : "The scissors experiment could not continue."); }
  };
  animation = requestAnimationFrame(tick); notify();
  initializationCleanup.push(() => cancelAnimationFrame(animation));
  initializationCleanup.length = 0;
  return {
    setMode, cut, reset, fit, focus, advance,
    setDepth(value: number) { if (busy || !Number.isFinite(value) || value < .5 || value > 3.5) return; instrument.group.position.addScaledVector(new THREE.Vector3(0, 1, 0).applyQuaternion(instrument.group.quaternion), seatOffset(depth) - seatOffset(value)); depth = value; changePose(); },
    setHandleVisible: instrument.setHandleVisible,
    setPosition(axis: number, value: number) { if (busy || !Number.isFinite(value) || axis < 0 || axis > 2) return; instrument.group.position.setComponent(axis, value); changePose(); },
    setRotation(axis: number, value: number) { if (busy || !Number.isFinite(value) || axis < 0 || axis > 2) return; const euler = new THREE.Euler().setFromQuaternion(instrument.group.quaternion, "XYZ"); const values = [euler.x, euler.y, euler.z]; values[axis] = rad(value); instrument.group.quaternion.setFromEuler(new THREE.Euler(values[0]!, values[1]!, values[2]!, "XYZ")); changePose(); },
    withdraw() { if (busy) return; instrument.group.position.addScaledVector(new THREE.Vector3(0, 1, 0).applyQuaternion(instrument.group.quaternion), 30); notice = "Instrument lifted clear. Use Place on liver to begin another incision."; changePose(); },
    snapshot: () => ({ schema: "viscera.scissors-workspace/v1", tool: pose(), opening, mode, insertionDepthMm: depth,
      camera: { positionMm: camera.position.toArray(), quaternion: camera.quaternion.toArray(), targetMm: orbit.target.toArray(), fovDegrees: camera.fov, aspect: camera.aspect },
      timing: clock.snapshot(), source: reference.source, surface: engine.snapshot(), limits: "Discrete finite jaw closures on a compliant surface shell; no calibrated volumetric fracture, bleeding, or full shaft contact." }),
    dispose() { if (disposed) return; disposed = true; cancelAnimationFrame(animation); observer.disconnect(); recording.dispose(); transform.dispose(); orbit.dispose(); canvas.removeEventListener("pointerdown", pointerDown); canvas.removeEventListener("pointermove", pointerMove); canvas.removeEventListener("pointerup", pointerUp, true); canvas.removeEventListener("keydown", keyDown); canvas.removeEventListener("pointercancel", pointerCancel); canvas.removeEventListener("lostpointercapture", pointerCancel); canvas.removeEventListener("blur", endTransformDrag); canvas.removeEventListener("webglcontextlost", lost); document.removeEventListener("visibilitychange", visibility); instrument.dispose(); for (const mesh of [skin!, walls!]) { mesh.geometry.dispose(); mesh.material.dispose(); } floorGeometry.dispose(); floorMaterial.dispose(); markerGeometry.dispose(); markerMaterial.dispose(); environment.dispose(); light.shadow.dispose(); renderer.dispose(); canvas.remove(); scene.clear(); delete host.dataset.scissorsDiagnostics; },
  };
  } catch (error) { for (const cleanup of initializationCleanup.reverse()) { try { cleanup(); } catch { /* Preserve the original setup error. */ } } throw error; }
}
export type ScissorsScene = ReturnType<typeof createScissorsScene>;
