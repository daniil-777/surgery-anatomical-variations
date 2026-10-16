import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import {
  TetPreview,
  effectiveWeights,
  embeddedPositionsMm,
  type TetModel,
} from "../../sim/src/index";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { pigmentModulation } from "./pigment";
import { geometryFor, synchronizeGeometry } from "./mesh-geometry";
import type {
  Appearance,
  BrushStroke,
  EditorTool,
  OrganMesh,
  SceneData,
  Vec3,
  ViewportHandle,
  ProbeReport,
} from "./types";
export type {
  Appearance,
  BrushStroke,
  EditorTool,
  OrganMesh,
  SceneData,
  Vec3,
  ViewportHandle,
  ProbeReport,
} from "./types";
interface Props {
  scene: SceneData | null;
  selectedId: string;
  hidden: Set<string>;
  locked: Set<string>;
  tool: EditorTool;
  radius: number;
  strength: number;
  appearance: Record<string, Appearance>;
  clip: number | null;
  showGrid: boolean;
  onSelect: (id: string) => void;
  onStrokeStart: () => void;
  onStroke: (stroke: BrushStroke) => void;
  onStrokeEnd: () => void;
  onStats?: (stats: {
    fps: number;
    triangles: number;
    scalePx: number;
  }) => void;
  onProbeReport?: (report: ProbeReport) => void;
  onProbe?: (depth: number) => void;
  onError?: (message: string) => void;
  onNotice?: (message: string) => void;
}
interface Runtime {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  group: THREE.Group;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  meshes: Map<
    string,
    THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>
  >;
  fit: () => void;
  preset: (p: string) => void;
  probe: () => void;
  grid: THREE.GridHelper;
  reset: () => void;
  dispose: () => void;
}
let normalCanvas: HTMLCanvasElement | null = null;
function tissueNormalTexture() {
  if (!normalCanvas) {
    const size = 256,
      data = new Uint8ClampedArray(size * size * 4);
    const hash = (x: number, y: number, period: number) => {
      x = ((x % period) + period) % period;
      y = ((y % period) + period) % period;
      let n = Math.imul(x + 17, 374761393) ^ Math.imul(y + 83, 668265263);
      n = Math.imul(n ^ (n >>> 13), 1274126177);
      return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
    };
    const smooth = (v: number) => v * v * v * (v * (v * 6 - 15) + 10);
    const noise = (x: number, y: number, f: number) => {
      const px = (x / size) * f,
        py = (y / size) * f,
        ix = Math.floor(px),
        iy = Math.floor(py),
        u = smooth(px - ix),
        v = smooth(py - iy);
      const a = hash(ix, iy, f),
        b = hash(ix + 1, iy, f),
        c = hash(ix, iy + 1, f),
        d = hash(ix + 1, iy + 1, f);
      return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
    };
    const height = (x: number, y: number) =>
      noise(x, y, 16) * 0.6 + noise(x, y, 37) * 0.28 + noise(x, y, 71) * 0.12;
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const dx = (height(x + 1, y) - height(x - 1, y)) * 0.7,
          dy = (height(x, y + 1) - height(x, y - 1)) * 0.7;
        const n = new THREE.Vector3(-dx, -dy, 1).normalize();
        const i = (y * size + x) * 4;
        data[i] = Math.round((n.x * 0.5 + 0.5) * 255);
        data[i + 1] = Math.round((n.y * 0.5 + 0.5) * 255);
        data[i + 2] = Math.round((n.z * 0.5 + 0.5) * 255);
        data[i + 3] = 255;
      }
    normalCanvas = document.createElement("canvas");
    normalCanvas.width = normalCanvas.height = size;
    normalCanvas
      .getContext("2d")!
      .putImageData(new ImageData(data, size, size), 0, 0);
  }
  const texture = new THREE.CanvasTexture(normalCanvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(5, 3);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  return texture;
}
export const AnatomyViewport = forwardRef<ViewportHandle, Props>(
  function AnatomyViewport(props, ref) {
    const host = useRef<HTMLDivElement>(null),
      runtime = useRef<Runtime | null>(null),
      latest = useRef(props);
    latest.current = props;
    useImperativeHandle(
      ref,
      () => ({
        camera: (p) => runtime.current?.preset(p),
        fit: () => runtime.current?.fit(),
        screenshot: () =>
          runtime.current?.renderer.domElement.toDataURL("image/png") ?? "",
        runProbe: () => runtime.current?.probe(),
        resetSimulation: () => runtime.current?.reset(),
        exportGLB: async () => {
          const r = runtime.current;
          if (!r) throw new Error("Renderer is not ready");
          const clone = r.group.clone(true);
          for (const child of [...clone.children])
            if (!child.userData.organId) clone.remove(child);
          clone.scale.multiplyScalar(0.001);
          clone.traverse((o) => {
            if (o instanceof THREE.Mesh) {
              o.material = o.material.clone();
              // Bake the selected tint into bounded linear vertex RGB. The
              // runtime uses relative pigment factors, which may exceed one;
              // glTF COLOR_0 is an absolute [0,1] reflectance multiplier.
              o.geometry = o.geometry.clone();
              const pigment = o.geometry.getAttribute("color");
              if (pigment) {
                const baked = new Float32Array(pigment.count * 3);
                for (let i = 0; i < pigment.count; i++) {
                  baked[i * 3] = THREE.MathUtils.clamp(
                    pigment.getX(i) * o.material.color.r,
                    0,
                    1,
                  );
                  baked[i * 3 + 1] = THREE.MathUtils.clamp(
                    pigment.getY(i) * o.material.color.g,
                    0,
                    1,
                  );
                  baked[i * 3 + 2] = THREE.MathUtils.clamp(
                    pigment.getZ(i) * o.material.color.b,
                    0,
                    1,
                  );
                }
                o.geometry.setAttribute(
                  "color",
                  new THREE.BufferAttribute(baked, 3),
                );
                o.material.color.setRGB(1, 1, 1);
              }
              o.material.clippingPlanes = [];
              o.userData = {
                organId: o.userData.organId,
                evidence: "Original procedural development preview; unreviewed",
              };
            }
          });
          try {
            const result = await new GLTFExporter().parseAsync(clone, {
              binary: true,
              onlyVisible: true,
            });
            if (!(result instanceof ArrayBuffer))
              throw new Error("GLB export returned an unexpected format");
            return result;
          } finally {
            clone.traverse((object) => {
              if (object instanceof THREE.Mesh) {
                object.geometry.dispose();
                object.material.dispose();
              }
            });
          }
        },
      }),
      [],
    );
    useEffect(() => {
      const el = host.current;
      if (!el) return;
      let renderer: THREE.WebGLRenderer;
      try {
        renderer = new THREE.WebGLRenderer({
          antialias: true,
          alpha: true,
          preserveDrawingBuffer: true,
          powerPreference: "high-performance",
        });
      } catch (error) {
        latest.current.onError?.(
          `3D renderer unavailable: ${error instanceof Error ? error.message : "WebGL2 initialization failed"}`,
        );
        return;
      }
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 0.9;
      renderer.localClippingEnabled = true;
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      el.appendChild(renderer.domElement);
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 4000);
      camera.position.set(330, 210, -500);
      const group = new THREE.Group();
      group.rotation.x = -Math.PI / 2;
      scene.add(group);
      const meshes = new Map<
        string,
        THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>
      >();
      const pmrem = new THREE.PMREMGenerator(renderer);
      const room = new RoomEnvironment();
      const env = pmrem.fromScene(room, 0.03);
      scene.environment = env.texture;
      room.dispose();
      pmrem.dispose();
      scene.add(new THREE.HemisphereLight(0xc6e4f3, 0x282020, 0.85));
      const key = new THREE.DirectionalLight(0xffeadc, 2.1);
      key.position.set(-180, 350, -300);
      scene.add(key);
      const rim = new THREE.DirectionalLight(0xafd9e8, 1.05);
      rim.position.set(250, 120, 180);
      scene.add(rim);
      const fill = new THREE.DirectionalLight(0xffe0d0, 0.25);
      fill.position.set(200, -70, -300);
      scene.add(fill);
      const grid = new THREE.GridHelper(550, 22, 0x344555, 0x1a2734);
      grid.position.y = -130;
      grid.material.transparent = true;
      grid.material.opacity = 0.27;
      scene.add(grid);
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.12;
      controls.minDistance = 50;
      controls.maxDistance = 1600;
      controls.maxPolarAngle = Math.PI * 0.98;
      controls.target.set(0, 0, 0);
      const ray = new THREE.Raycaster(),
        mouse = new THREE.Vector2(),
        plane = new THREE.Plane(),
        pointer = new THREE.Vector3();
      let stroke: {
        id: string;
        point: Vec3;
        normal: Vec3;
        last: THREE.Vector3;
      } | null = null;
      const cursor = new THREE.Mesh(
        new THREE.RingGeometry(0.98, 1.015, 80),
        new THREE.MeshBasicMaterial({
          color: 0x58eee0,
          transparent: true,
          opacity: 0.9,
          side: THREE.DoubleSide,
          depthTest: false,
        }),
      );
      cursor.renderOrder = 100;
      cursor.visible = false;
      group.add(cursor);
      let probe: {
        mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>;
        base: Float32Array;
        point: THREE.Vector3;
        normal: THREE.Vector3;
        start: number;
        radius: number;
        solver: TetPreview;
        model: TetModel;
        tetIds: number[];
        weights: Float64Array;
        accumulator: number;
        last: number;
        released: boolean;
        complete: boolean;
        maxDrift: number;
        minJ: number;
        peakDisplacement: number;
      } | null = null;
      const stopProbe = () => {
        if (probe) {
          probe.mesh.geometry.setAttribute(
            "position",
            new THREE.BufferAttribute(probe.base, 3),
          );
          probe.mesh.geometry.computeVertexNormals();
          probe = null;
          latest.current.onProbe?.(0);
        }
      };
      const rayAt = (e: PointerEvent) => {
        const rect = renderer.domElement.getBoundingClientRect();
        mouse.set(
          ((e.clientX - rect.left) / rect.width) * 2 - 1,
          (-(e.clientY - rect.top) / rect.height) * 2 + 1,
        );
        ray.setFromCamera(mouse, camera);
        return ray.intersectObjects(
          [...meshes.values()].filter((m) => m.visible),
          false,
        )[0];
      };
      const startProbe = (
        mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>,
        worldPoint: THREE.Vector3,
        normal: THREE.Vector3,
      ) => {
        stopProbe();
        const data = latest.current.scene?.simulation;
        const organ = latest.current.scene?.organs.find(
          (o) => o.id === mesh.userData.organId,
        );
        if (
          !data ||
          !organ ||
          organ.metadata?.editor_modified ||
          (data.organ_id ?? data.organId ?? "liver") !== organ.id
        ) {
          latest.current.onNotice?.(
            "A matching tetrahedral preview is unavailable for this surface. Generate a new unedited liver to run the probe.",
          );
          return;
        }
        try {
          const tetIds =
            data.embedding.tet_ids ?? data.embedding.tet_indices ?? [];
          const residuals =
            data.embedding.residuals_mm ??
            data.embedding.rest_residuals_mm ??
            [];
          if (tetIds.length !== organ.positions.length / 3)
            throw new Error(
              "Surface mapping does not match the current geometry",
            );
          const model: TetModel = {
            positions_mm: data.positions_mm,
            tets: data.tets,
            ...(data.pinned_nodes ? { pinned_nodes: data.pinned_nodes } : {}),
            ...(data.density_kg_m3
              ? { density_kg_m3: data.density_kg_m3 }
              : {}),
          };
          const solver = new TetPreview(model, { gravity: [0, 0, 0] });
          const weights = effectiveWeights(model, {
            tet_ids: tetIds,
            weights: data.embedding.weights,
            residuals_mm: residuals,
          });
          const reconstructed = embeddedPositionsMm(
            model,
            tetIds,
            weights,
            solver.reference,
          );
          let referenceErrorMm = 0;
          for (let i = 0; i < reconstructed.length; i++) {
            referenceErrorMm = Math.max(
              referenceErrorMm,
              Math.abs(reconstructed[i]! - organ.positions[i]!),
            );
          }
          if (!Number.isFinite(referenceErrorMm) || referenceErrorMm > 0.02) {
            throw new Error(
              "The simulation mapping does not reconstruct this reference surface. Regenerate the specimen before probing.",
            );
          }
          const now = performance.now();
          probe = {
            mesh,
            base: new Float32Array(
              mesh.geometry.getAttribute("position").array,
            ),
            point: group.worldToLocal(worldPoint.clone()),
            normal: normal.clone(),
            start: now,
            radius: Math.max(latest.current.radius, 35),
            solver,
            model,
            tetIds,
            weights,
            accumulator: 0,
            last: now,
            released: false,
            complete: false,
            maxDrift: 0,
            minJ: 1,
            peakDisplacement: 0,
          };
          latest.current.onNotice?.(
            "Running a tetrahedral XPBD displacement preview. This is not a calibrated sphere-contact force test.",
          );
        } catch (error) {
          latest.current.onNotice?.(
            error instanceof Error ? error.message : "Invalid simulation proxy",
          );
        }
      };
      const onDown = (e: PointerEvent) => {
        const p = latest.current;
        controls.enabled = p.tool === "orbit" || e.button !== 0 || e.altKey;
        if (e.button !== 0 || e.altKey) return;
        const hit = rayAt(e);
        if (!hit) return;
        const id = hit.object.userData.organId as string;
        p.onSelect(id);
        if (p.tool === "orbit" || p.locked.has(id)) return;
        e.preventDefault();
        renderer.domElement.setPointerCapture(e.pointerId);
        const local = group.worldToLocal(hit.point.clone()),
          n = hit.face?.normal.clone() ?? new THREE.Vector3(0, 1, 0);
        if (p.tool === "probe") {
          startProbe(
            hit.object as THREE.Mesh<
              THREE.BufferGeometry,
              THREE.MeshPhysicalMaterial
            >,
            hit.point,
            n,
          );
          return;
        }
        stopProbe();
        stroke = {
          id,
          point: local.toArray() as Vec3,
          normal: n.toArray() as Vec3,
          last: hit.point.clone(),
        };
        plane.setFromNormalAndCoplanarPoint(
          camera.getWorldDirection(new THREE.Vector3()),
          hit.point,
        );
        p.onStrokeStart();
      };
      const onMove = (e: PointerEvent) => {
        const p = latest.current;
        if (stroke) {
          rayAt(e);
          if (ray.ray.intersectPlane(plane, pointer)) {
            const a = group.worldToLocal(pointer.clone()),
              b = group.worldToLocal(stroke.last.clone());
            const d = a.sub(b);
            d.clampLength(0, p.radius * 0.1);
            if (d.length() > 0.01 || p.tool === "smooth") {
              p.onStroke({
                organId: stroke.id,
                point: stroke.point,
                normal: stroke.normal,
                delta: d.toArray() as Vec3,
                radius: p.radius,
                strength: p.strength,
                tool: p.tool,
              });
              stroke.last.copy(pointer);
            }
          }
          return;
        }
        const hit = rayAt(e);
        cursor.visible =
          !!hit &&
          p.tool !== "orbit" &&
          !p.locked.has(hit.object.userData.organId as string);
        if (hit && cursor.visible) {
          cursor.position.copy(group.worldToLocal(hit.point.clone()));
          const n = hit.face?.normal ?? new THREE.Vector3(0, 1, 0);
          cursor.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
          cursor.scale.setScalar(p.radius);
          cursor.position.addScaledVector(n, 0.25);
        }
        renderer.domElement.style.cursor =
          p.tool === "orbit" ? "grab" : "crosshair";
      };
      const onUp = () => {
        if (stroke) {
          stroke = null;
          latest.current.onStrokeEnd();
        }
        controls.enabled = latest.current.tool === "orbit";
      };
      const onLeave = () => {
        cursor.visible = false;
      };
      renderer.domElement.addEventListener("pointerdown", onDown, true);
      renderer.domElement.addEventListener("pointermove", onMove);
      renderer.domElement.addEventListener("pointerup", onUp);
      renderer.domElement.addEventListener("pointercancel", onUp);
      renderer.domElement.addEventListener("pointerleave", onLeave);
      const box = () => {
        const b = new THREE.Box3();
        for (const m of meshes.values()) if (m.visible) b.expandByObject(m);
        return b;
      };
      const fit = () => {
        group.updateWorldMatrix(true, true);
        const b = box();
        if (b.isEmpty()) return;
        const c = b.getCenter(new THREE.Vector3()),
          size = b.getSize(new THREE.Vector3());
        const d =
          Math.max(
            size.x / Math.min(camera.aspect, 1.5),
            size.y,
            size.z * 0.8,
          ) * 2.25;
        const dir = camera.position.clone().sub(controls.target).normalize();
        controls.target.copy(c);
        camera.position.copy(c).addScaledVector(dir, d);
        camera.near = Math.max(0.1, d / 1000);
        camera.far = Math.max(3000, d * 10);
        camera.updateProjectionMatrix();
        grid.position.y = b.min.y - 12;
        controls.update();
      };
      const preset = (p: string) => {
        const c = controls.target.clone();
        const d = camera.position.distanceTo(c);
        const dir =
          p === "anterior"
            ? new THREE.Vector3(0, 0.05, -1)
            : p === "posterior"
              ? new THREE.Vector3(0, 0.05, 1)
              : p === "superior"
                ? new THREE.Vector3(0, 1, -0.001)
                : new THREE.Vector3(0.55, 0.3, -1).normalize();
        camera.position.copy(c).addScaledVector(dir, d);
        camera.up.set(0, 1, 0);
        controls.update();
      };
      const runProbe = () => {
        const m = meshes.get(latest.current.selectedId);
        if (!m || !m.visible) return;
        const b = new THREE.Box3().setFromObject(m);
        const c = b.getCenter(new THREE.Vector3());
        ray.set(camera.position, c.sub(camera.position).normalize());
        const hit = ray.intersectObject(m, false)[0];
        if (hit)
          startProbe(
            m,
            hit.point,
            hit.face?.normal ?? new THREE.Vector3(0, 1, 0),
          );
      };
      let frame = 0,
        last = performance.now(),
        count = 0,
        raf = 0,
        disposed = false;
      const animate = () => {
        if (disposed) return;
        raf = requestAnimationFrame(animate);
        controls.update();
        if (probe && !probe.complete) {
          const now = performance.now();
          probe.accumulator = Math.min(
            probe.accumulator + (now - probe.last) / 1000,
            4 / 120,
          );
          probe.last = now;
          let steps = 0;
          while (probe.accumulator >= 1 / 120 && steps < 4) {
            const t = probe.solver.time;
            if (t < 0.8) {
              const depth =
                4.5 * Math.sin((Math.min(1, t / 0.6) * Math.PI) / 2);
              probe.solver.grab(
                probe.point.toArray(),
                probe.radius,
                probe.normal.clone().multiplyScalar(-depth).toArray(),
              );
            } else if (!probe.released) {
              probe.solver.release();
              probe.released = true;
            }
            probe.solver.step(1 / 120);
            probe.accumulator -= 1 / 120;
            steps++;
            if (probe.solver.rejectedSteps || probe.solver.time >= 3.5) break;
          }
          const positions = embeddedPositionsMm(
            probe.model,
            probe.tetIds,
            probe.weights,
            probe.solver.positions,
          );
          const pos = probe.mesh.geometry.getAttribute(
            "position",
          ) as THREE.BufferAttribute;
          pos.array.set(positions);
          pos.needsUpdate = true;
          probe.mesh.geometry.computeVertexNormals();
          let displacement = 0;
          for (let i = 0; i < positions.length; i += 3)
            displacement = Math.max(
              displacement,
              Math.hypot(
                positions[i]! - probe.base[i]!,
                positions[i + 1]! - probe.base[i + 1]!,
                positions[i + 2]! - probe.base[i + 2]!,
              ),
            );
          probe.peakDisplacement = Math.max(
            probe.peakDisplacement,
            displacement,
          );
          const metrics = probe.solver.metrics();
          probe.maxDrift = Math.max(
            probe.maxDrift,
            Math.abs(metrics.volumeDrift),
          );
          probe.minJ = Math.min(probe.minJ, metrics.minJacobian);
          const done = metrics.rejectedSteps > 0 || metrics.time >= 3.5;
          if (frame % 3 === 0 || done) {
            latest.current.onProbe?.(displacement);
            latest.current.onProbeReport?.({
              time: metrics.time,
              minJacobian: probe.minJ,
              maxVolumeDrift: probe.maxDrift,
              rejectedSteps: metrics.rejectedSteps,
              maxDisplacementMm: probe.peakDisplacement,
              recoveryResidualMm: displacement,
              status: metrics.rejectedSteps
                ? "rejected"
                : done
                  ? "complete"
                  : "running",
            });
          }
          if (done) {
            probe.complete = true;
            latest.current.onNotice?.(
              metrics.rejectedSteps
                ? "Preview stopped after a rejected step; last valid state retained."
                : "Preview finished. Terminal displacement and measured residual retained until Reset.",
            );
          }
        }
        renderer.render(scene, camera);
        frame++;
        count++;
        const now = performance.now();
        if (now - last > 1000) {
          latest.current.onStats?.({
            fps: Math.round((count * 1000) / (now - last)),
            triangles: renderer.info.render.triangles,
            scalePx:
              (50 * el.clientHeight) /
              (2 *
                camera.position.distanceTo(controls.target) *
                Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))),
          });
          last = now;
          count = 0;
        }
      };
      const resize = new ResizeObserver(() => {
        const w = el.clientWidth,
          h = el.clientHeight;
        if (!w || !h) return;
        renderer.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      });
      resize.observe(el);
      const dispose = () => {
        disposed = true;
        cancelAnimationFrame(raf);
        resize.disconnect();
        controls.dispose();
        renderer.domElement.removeEventListener("pointerdown", onDown, true);
        renderer.domElement.removeEventListener("pointermove", onMove);
        renderer.domElement.removeEventListener("pointerup", onUp);
        renderer.domElement.removeEventListener("pointercancel", onUp);
        renderer.domElement.removeEventListener("pointerleave", onLeave);
        for (const m of meshes.values()) {
          m.geometry.dispose();
          m.material.normalMap?.dispose();
          m.material.dispose();
        }
        cursor.geometry.dispose();
        cursor.material.dispose();
        grid.geometry.dispose();
        grid.material.dispose();
        env.dispose();
        renderer.dispose();
        renderer.domElement.remove();
      };
      runtime.current = {
        renderer,
        scene,
        group,
        camera,
        controls,
        meshes,
        fit,
        preset,
        probe: runProbe,
        grid,
        reset: stopProbe,
        dispose,
      };
      animate();
      return () => {
        dispose();
        runtime.current = null;
      };
    }, []);
    useEffect(() => {
      const r = runtime.current;
      if (!r || !props.scene) return;
      r.reset();
      const organs = [...props.scene.organs, ...(props.scene.vessels ?? [])];
      const ids = new Set(organs.map((o) => o.id));
      for (const [id, m] of r.meshes)
        if (!ids.has(id)) {
          r.group.remove(m);
          m.geometry.dispose();
          m.material.normalMap?.dispose();
          m.material.dispose();
          r.meshes.delete(id);
        }
      const first = r.meshes.size === 0;
      for (const o of organs) {
        let pigment: Float32Array;
        try {
          pigment = pigmentModulation(o);
        } catch (error) {
          const stale = r.meshes.get(o.id);
          if (stale) {
            r.group.remove(stale);
            stale.geometry.dispose();
            stale.material.normalMap?.dispose();
            stale.material.dispose();
            r.meshes.delete(o.id);
          }
          latest.current.onError?.(
            error instanceof Error ? error.message : "Invalid pigment artifact",
          );
          continue;
        }
        let m = r.meshes.get(o.id);
        if (!m) {
          const mat = new THREE.MeshPhysicalMaterial({
            color: o.color ?? "#66352c",
            roughness: 0.48,
            metalness: 0,
            clearcoat: 0.2,
            clearcoatRoughness: 0.2,
            normalMap: tissueNormalTexture(),
            normalScale: new THREE.Vector2(0.12, 0.12),
            vertexColors: true,
            side: THREE.DoubleSide,
            envMapIntensity: 0.3,
          });
          m = new THREE.Mesh(geometryFor(o, pigment), mat);
          m.userData = {
            organId: o.id,
            name: o.name,
            evidence: "procedural; unreviewed; surface preview",
          };
          m.name = o.name;
          r.meshes.set(o.id, m);
          r.group.add(m);
        } else if (
          m.userData.sourcePositions !== o.positions ||
          m.userData.sourceIndices !== o.indices ||
          m.userData.sourceUv !== o.uv ||
          m.userData.sourceNormals !== o.normals
        ) {
          synchronizeGeometry(m.geometry, o, pigment);
        }
        if (
          m.userData.sourceColors !== o.colors ||
          m.userData.sourceColor !== o.color
        ) {
          m.geometry.setAttribute(
            "color",
            new THREE.BufferAttribute(pigment, 3),
          );
        }
        m.userData.sourcePositions = o.positions;
        m.userData.sourceIndices = o.indices;
        m.userData.sourceUv = o.uv;
        m.userData.sourceNormals = o.normals;
        m.userData.sourceColors = o.colors;
        m.userData.sourceColor = o.color;
      }
      if (first) r.fit();
    }, [props.scene]);
    useEffect(() => {
      const r = runtime.current;
      if (!r) return;
      for (const [id, m] of r.meshes) {
        m.visible = !props.hidden.has(id);
        const a = props.appearance[id];
        if (a) {
          m.material.color.set(a.color);
          m.material.roughness = a.roughness;
          m.material.clearcoat = a.clearcoat;
          m.material.opacity = a.opacity;
          m.material.transparent = a.opacity < 1;
          m.material.depthWrite = a.opacity >= 0.9;
          m.material.wireframe = a.wireframe;
        }
        m.material.emissive.set(id === props.selectedId ? 0x2a0907 : 0x000000);
        m.material.emissiveIntensity = id === props.selectedId ? 0.09 : 0;
        m.material.clippingPlanes =
          props.clip === null
            ? []
            : [new THREE.Plane(new THREE.Vector3(0, 0, -1), props.clip)];
        m.material.needsUpdate = true;
      }
      r.grid.visible = props.showGrid;
      r.controls.enabled = props.tool === "orbit";
    }, [
      props.scene,
      props.selectedId,
      props.hidden,
      props.appearance,
      props.clip,
      props.showGrid,
      props.tool,
    ]);
    return (
      <div
        className="anatomy-canvas"
        ref={host}
        data-testid="anatomy-viewport"
        aria-label="Interactive 3D anatomy viewport"
      />
    );
  },
);
