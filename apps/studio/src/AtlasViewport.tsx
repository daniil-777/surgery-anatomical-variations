import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { SceneData } from "@viscera/render";
import { beginSurfaceSculpt, type SurfaceSculptStroke, type SurfaceSculptResult } from "./atlasSurfaceSculpt";
import { installAtlasVessels } from "./atlasVesselShader";
import type { AtlasVesselNetwork } from "./atlasVessels";
import type { SurfaceEdit } from "./atlasSculptHistory";
import type { AtlasAppearance } from "./atlas";
import { ATLAS_MATERIAL_SHADER_SHA256, ATLAS_MATERIAL_SHADER_VERSION, installAtlasMaterial, readAtlasMaterial } from "./atlasMaterialShader";
import { installPhotoDetail, photoDetailFor } from "./photoDetail";

export const ATLAS_RENDER_VERSION = "atlas-neutral-inspection-1.1.0";

export type AtlasView = "front" | "back" | "top" | "oblique";
export interface AtlasViewportHandle {
  fit: () => void;
  view: (preset: AtlasView) => void;
  screenshot: () => string;
  captureMetadata: () => Record<string, unknown>;
}
export interface AtlasMeshStats {
  triangles: number;
  vertices: number;
  extentMm: [number, number, number];
}
interface Props {
  scene: SceneData | null;
  appearance: AtlasAppearance;
  wireframe: boolean;
  sculptEnabled?: boolean;
  sculptRadius?: number;
  sculptStiffness?: number;
  onSculptCommit?: (edit: SurfaceEdit, report: string) => void;
  /** Preserve camera framing while this identity stays the same. Omit for per-scene fitting. */
  fitKey?: string | undefined;
  /** Photo-derived detail over the tissue material (photoDetail.ts), 0 = off. */
  photoDetail?: number;
  /** Height the photograph's shading adds as relief, in mm. */
  photoRelief?: number;
  onStats: (stats: AtlasMeshStats) => void;
  onError: (message: string) => void;
}
interface Runtime {
  renderer: THREE.WebGLRenderer;
  group: THREE.Group;
  controls: OrbitControls;
  camera: THREE.PerspectiveCamera;
  framingKey?: string | undefined;
  cancelDrag: () => void;
  fit: () => void;
  view: (preset: AtlasView) => void;
}

function materialValue(definition: unknown, key: string, fallback: number): number {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) return fallback;
  const value = (definition as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

function disposeMeshes(group: THREE.Group) {
  for (const child of [...group.children]) {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose();
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) material.dispose();
    }
    group.remove(child);
  }
}

/** Atlas geometry is centered, Y-up and millimetre-scaled. V1 artifact colors
 * remain unchanged; v2 samples authored rest-space fields for fragment shading
 * only. View names are geometric, not patient anatomical orientations. */
export const AtlasViewport = forwardRef<AtlasViewportHandle, Props>(function AtlasViewport(props, ref) {
  const photoMaterials = useRef<THREE.MeshPhysicalMaterial[]>([]);
  const photoStrength = props.photoDetail ?? 0, photoRelief = props.photoRelief ?? 0.03;
  useEffect(() => {
    let live = true;
    for (const material of photoMaterials.current) {
      const organ = String(material.userData.photoOrgan);
      if (photoStrength <= 0) { installPhotoDetail(material, null, 0); continue; }
      void photoDetailFor(organ).then((detail) => { if (live && photoMaterials.current.includes(material)) installPhotoDetail(material, detail, photoStrength, photoRelief); }).catch(() => {});
    }
    return () => { live = false; };
  }, [photoStrength, photoRelief, props.scene, props.appearance]);
  const host = useRef<HTMLDivElement>(null);
  const runtime = useRef<Runtime | null>(null);
  const latest = useRef(props);
  latest.current = props;
  useImperativeHandle(ref, () => ({
    fit: () => runtime.current?.fit(),
    view: (preset) => runtime.current?.view(preset),
    screenshot: () => runtime.current?.renderer.domElement.toDataURL("image/png") ?? "",
    captureMetadata: () => {
      const current = runtime.current;
      if (!current) return {};
      const rounded = (values: number[]) => values.map((value) => Number(value.toFixed(6)));
      const materialV2 = current.group.children.some((mesh) => Boolean(mesh.userData.materialV2));
      return {
        renderer_version: materialV2 ? "atlas-neutral-inspection-material-2.0.0" : ATLAS_RENDER_VERSION,
        ...(materialV2 ? { material_shader: { version: ATLAS_MATERIAL_SHADER_VERSION, sha256: ATLAS_MATERIAL_SHADER_SHA256, coordinates: "template_rest_mm", geometry_modified: false } } : {}),
        camera: {
          projection: "perspective", fov_degrees: current.camera.fov,
          position_mm: rounded(current.camera.position.toArray()),
          target_mm: rounded(current.controls.target.toArray()),
          up: rounded(current.camera.up.toArray()),
          near_mm: current.camera.near, far_mm: current.camera.far,
          aspect: current.camera.aspect, fit_padding: 1.12,
        },
        lighting: {
          exposure: 0.82, tone_mapping: "ACESFilmic", output_color_space: "sRGB",
          hemisphere: { sky: "#e2edff", ground: "#55515b", intensity: 0.45 },
          key: { color: "#fff1e4", intensity: 1.4, position: [-400, 600, 500] },
          rim: { color: "#c8e8ff", intensity: 0.65, position: [400, 220, -360] },
          fill: { color: "#ffeded", intensity: 0.25, position: [200, -100, 300] },
          environment: "Three RoomEnvironment PMREM blur 0.06", environment_intensity: 0.2,
        },
      };
    },
    // account platform (platform/labs/organ/useOrganLabSession.ts): the camera of a saved session, a probe for a sculpt
    // drag in progress, and a still rendered and read in one task (sculpt hover ring hidden, the stage's gradient behind
    // the organ, cover-cropped) so it never depends on the frame loop, which pauses in hidden tabs
    getCamera: () => {
      const current = runtime.current;
      if (!current) return null;
      return {
        position_mm: current.camera.position.toArray(), target_mm: current.controls.target.toArray(), up: current.camera.up.toArray(),
        fov_degrees: current.camera.fov, near_mm: current.camera.near, far_mm: current.camera.far,
      };
    },
    setCamera: (pose: { position_mm: readonly number[]; target_mm: readonly number[]; fov_degrees: number; near_mm: number; far_mm: number }) => {
      const current = runtime.current;
      if (!current || !current.group.children.length) return false;
      const values = [...pose.position_mm, ...pose.target_mm, pose.fov_degrees, pose.near_mm, pose.far_mm];
      if (values.length !== 9 || !values.every((value) => Number.isFinite(value)) || !(pose.near_mm > 0 && pose.far_mm > pose.near_mm)) return false;
      current.cancelDrag();
      current.camera.fov = pose.fov_degrees; current.camera.near = pose.near_mm; current.camera.far = pose.far_mm;
      current.camera.position.set(values[0]!, values[1]!, values[2]!);
      current.controls.target.set(values[3]!, values[4]!, values[5]!);
      current.camera.updateProjectionMatrix();
      current.controls.update();
      return true;
    },
    isInteracting: () => Boolean(runtime.current && !runtime.current.controls.enabled),
    captureThumbnail: async ({ width, height, background = "stage" }: { width: number; height: number; background?: "stage" | "transparent" | undefined }) => {
      const current = runtime.current;
      const w = Math.round(width), h = Math.round(height);
      if (!current || !current.group.children.length || !current.controls.enabled || !(w > 0 && h > 0 && w <= 4096 && h <= 4096)) return null;
      const source = current.renderer.domElement;
      // a scene recording owns the canvas; a lost context reads blank
      if (source.dataset.sceneRecordingActive === "true" || current.renderer.getContext().isContextLost() || !source.width || !source.height) return null;
      // the texture lab's photo layer arrives asynchronously: let the tiles its materials asked for install first
      if ((latest.current.photoDetail ?? 0) > 0) await Promise.all(photoMaterials.current.map((material) => photoDetailFor(String(material.userData.photoOrgan)).catch(() => null)));
      const scene = current.group.parent;
      if (runtime.current !== current || !current.controls.enabled || !scene) return null;
      const output = document.createElement("canvas");
      output.width = w; output.height = h;
      const context = output.getContext("2d");
      if (!context) return null;
      if (background === "stage") {
        // .atlas-stage's backdrop (atlas.css), painted as AtlasWitness paints it
        context.save(); context.translate(w / 2, h / 2); context.scale(w / 2, h / 2);
        const gradient = context.createRadialGradient(0, 0, 0, 0, 0, Math.SQRT2);
        gradient.addColorStop(0, "#2b3035"); gradient.addColorStop(0.47, "#181e26"); gradient.addColorStop(1, "#111720");
        context.fillStyle = gradient; context.fillRect(-1, -1, 2, 2); context.restore();
      }
      const overlays = scene.children.filter((child) => child !== current.group && child.visible && child instanceof THREE.Mesh);
      for (const child of overlays) child.visible = false;
      try {
        current.renderer.render(scene, current.camera);
        const scale = Math.max(w / source.width, h / source.height);
        const sw = w / scale, sh = h / scale;
        context.imageSmoothingEnabled = true; context.imageSmoothingQuality = "high";
        context.drawImage(source, (source.width - sw) / 2, (source.height - sh) / 2, sw, sh, 0, 0, w, h);
      } finally {
        for (const child of overlays) child.visible = true;
      }
      const encode = (type: string, quality?: number) => new Promise<Blob | null>((resolve) => output.toBlob(resolve, type, quality));
      const webp = await encode("image/webp", 0.86);
      return webp?.type === "image/webp" ? webp : await encode("image/png");
    },
  }), []);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: "high-performance",
      });
    } catch (error) {
      latest.current.onError(`The 3D viewer could not start: ${error instanceof Error ? error.message : "WebGL2 unavailable"}`);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.82;
    renderer.setClearColor(0, 0);
    renderer.domElement.setAttribute("aria-label", "Rotate the organ with the mouse or touch; use view buttons for preset views");
    element.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const group = new THREE.Group();
    scene.add(group);
    const camera = new THREE.PerspectiveCamera(33, 1, 0.01, 10000);
    camera.position.set(260, 130, 360);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.09;
    controls.screenSpacePanning = true;
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    const environment = pmrem.fromScene(room, 0.06);
    room.dispose();
    pmrem.dispose();
    scene.environment = environment.texture;
    scene.add(new THREE.HemisphereLight(0xe2edff, 0x55515b, 0.45));
    const key = new THREE.DirectionalLight(0xfff1e4, 1.4);
    key.position.set(-400, 600, 500);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xc8e8ff, 0.65);
    rim.position.set(400, 220, -360);
    scene.add(rim);
    const fill = new THREE.DirectionalLight(0xffeded, 0.25);
    fill.position.set(200, -100, 300);
    scene.add(fill);

    let fitRadius = 100;
    const center = new THREE.Vector3();
    const fit = () => {
      if (!group.children.length) return;
      const bounds = new THREE.Box3().setFromObject(group);
      if (bounds.isEmpty()) return;
      const sphere = bounds.getBoundingSphere(new THREE.Sphere());
      fitRadius = Math.max(sphere.radius, 0.1);
      center.copy(sphere.center);
      const direction = camera.position.clone().sub(controls.target).normalize();
      if (!direction.lengthSq()) direction.set(0.5, 0.25, 1).normalize();
      const vertical = THREE.MathUtils.degToRad(camera.fov / 2);
      const horizontal = Math.atan(Math.tan(vertical) * camera.aspect);
      const distance = fitRadius / Math.sin(Math.min(vertical, horizontal)) * 1.12;
      camera.near = Math.max(fitRadius / 10000, 0.001);
      camera.far = fitRadius * 200;
      camera.updateProjectionMatrix();
      camera.position.copy(center).addScaledVector(direction, distance);
      controls.target.copy(center);
      controls.minDistance = fitRadius * 0.08;
      controls.maxDistance = fitRadius * 40;
      controls.update();
    };
    const view = (preset: AtlasView) => {
      const vectors: Record<AtlasView, [number, number, number]> = {
        front: [0, 0, 1], back: [0, 0, -1], top: [0, 1, 0.00001], oblique: [0.65, 0.3, 1],
      };
      camera.position.copy(controls.target).add(new THREE.Vector3(...vectors[preset]).normalize().multiplyScalar(fitRadius * 4));
      fit();
    };
    const resize = new ResizeObserver(() => {
      if (!element.clientWidth || !element.clientHeight) return;
      renderer.setSize(element.clientWidth, element.clientHeight);
      camera.aspect = element.clientWidth / element.clientHeight;
      camera.updateProjectionMatrix();
    });
    resize.observe(element);
    renderer.setSize(element.clientWidth || 600, element.clientHeight || 600);
    camera.aspect = (element.clientWidth || 600) / (element.clientHeight || 600);
    camera.updateProjectionMatrix();
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const marker = new THREE.Mesh(new THREE.RingGeometry(0.965, 1, 80), new THREE.MeshBasicMaterial({ color: 0xb0efdc, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthTest: false }));
    marker.visible = false; marker.renderOrder = 10; scene.add(marker);
    const canvas = renderer.domElement;
    let drag: { pointerId: number; mesh: THREE.Mesh; start: THREE.Vector3; plane: THREE.Plane; stroke: SurfaceSculptStroke; result: SurfaceSculptResult | null; original: Float32Array; originalNormals: Float32Array; pending: [number, number, number] | null } | null = null;
    const setRay = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
    };
    const pick = (event: PointerEvent) => {
      setRay(event);
      return raycaster.intersectObjects(group.children, false).find(hit => hit.object.userData.sculptable);
    };
    const updateGeometry = (mesh: THREE.Mesh, positions: Float32Array) => {
      const attribute = mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
      (attribute.array as Float32Array).set(positions); attribute.needsUpdate = true;
      mesh.geometry.computeVertexNormals(); mesh.geometry.computeBoundingSphere(); mesh.geometry.computeBoundingBox();
    };
    const flushDrag = () => {
      if (!drag?.pending) return;
      try {
        drag.result = drag.stroke.update(drag.pending); drag.pending = null;
        updateGeometry(drag.mesh, drag.result.positions);
      } catch (error) {
        latest.current.onError(`Surface edit could not be applied: ${error instanceof Error ? error.message : String(error)}`);
        cancelDrag();
      }
    };
    const cancelDrag = () => {
      if (drag) {
        const active = drag; drag = null;
        updateGeometry(active.mesh, active.original);
        (active.mesh.geometry.getAttribute("normal").array as Float32Array).set(active.originalNormals);
        active.mesh.geometry.getAttribute("normal").needsUpdate = true;
        if (canvas.hasPointerCapture(active.pointerId)) canvas.releasePointerCapture(active.pointerId);
      }
      controls.enabled = true; marker.visible = false;
    };
    const down = (event: PointerEvent) => {
      if (!latest.current.sculptEnabled || event.button !== 0 || drag) return;
      const hit = pick(event);
      if (!hit || hit.faceIndex === undefined || hit.faceIndex === null) return;
      event.preventDefault(); event.stopImmediatePropagation();
      const mesh = hit.object as THREE.Mesh;
      const positions = mesh.geometry.getAttribute("position").array as Float32Array;
      try {
        const stroke = beginSurfaceSculpt({ positions, guardPositions: mesh.userData.guardPositions as number[], indices: mesh.geometry.index!.array, faceIndex: hit.faceIndex,
          point: hit.point.toArray() as [number, number, number], radius: latest.current.sculptRadius ?? 35,
          stiffness: latest.current.sculptStiffness ?? 0.45, preserveVolume: 0.9 });
        const normal = camera.getWorldDirection(new THREE.Vector3());
        drag = { pointerId: event.pointerId, mesh, start: hit.point.clone(), plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, hit.point), stroke, result: null, original: new Float32Array(positions), originalNormals: new Float32Array(mesh.geometry.getAttribute("normal").array as Float32Array), pending: null };
        controls.enabled = false; canvas.setPointerCapture(event.pointerId); marker.visible = false;
      } catch (error) { latest.current.onError(error instanceof Error ? error.message : String(error)); }
    };
    const move = (event: PointerEvent) => {
      if (drag) {
        if (event.pointerId !== drag.pointerId) return;
        event.preventDefault(); event.stopImmediatePropagation(); setRay(event);
        const target = raycaster.ray.intersectPlane(drag.plane, new THREE.Vector3());
        if (target) drag.pending = target.sub(drag.start).toArray() as [number, number, number];
        return;
      }
      marker.visible = false;
      canvas.style.cursor = latest.current.sculptEnabled ? "crosshair" : "grab";
      if (!latest.current.sculptEnabled || event.buttons) return;
      const hit = pick(event);
      if (!hit?.face) return;
      marker.position.copy(hit.point).addScaledVector(hit.face.normal, 0.1);
      marker.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), hit.face.normal);
      marker.scale.setScalar(latest.current.sculptRadius ?? 35); marker.visible = true;
    };
    const up = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      event.preventDefault(); event.stopImmediatePropagation(); flushDrag();
      const active = drag; drag = null; controls.enabled = true; marker.visible = false;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      if (!active) return;
      if (!active.result || active.result.diagnostics.maxDisplacement < 0.0001) {
        updateGeometry(active.mesh, active.original);
        (active.mesh.geometry.getAttribute("normal").array as Float32Array).set(active.originalNormals);
        active.mesh.geometry.getAttribute("normal").needsUpdate = true;
        return;
      }
      const d = active.result.diagnostics;
      const volume = d.volumeChangeFraction === null ? "open surface" : `${(d.volumeChangeFraction * 100).toFixed(2)}% volume change`;
      latest.current.onSculptCommit?.({ organ_id: active.mesh.userData.organId as string, positions: Array.from(active.result.positions) },
        `${d.maxDisplacement.toFixed(1)} mm displacement · ${volume}${d.guarded ? " · edit limited to preserve local geometry" : ""}`);
    };
    const cancelPointer = (event: PointerEvent) => { if (drag?.pointerId === event.pointerId) cancelDrag(); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") cancelDrag(); };
    const leave = () => { if (!drag) marker.visible = false; };
    canvas.addEventListener("pointerdown", down, true);
    canvas.addEventListener("pointermove", move, true);
    canvas.addEventListener("pointerup", up, true);
    canvas.addEventListener("pointercancel", cancelPointer);
    canvas.addEventListener("lostpointercapture", cancelPointer);
    canvas.addEventListener("pointerleave", leave);
    window.addEventListener("keydown", escape);
    let frame = 0;
    let disposed = false;
    const animate = () => {
      if (disposed) return;
      frame = requestAnimationFrame(animate);
      if (!document.hidden) {
        flushDrag();
        if (!drag) controls.update();
        renderer.render(scene, camera);
      }
    };
    const contextLost = (event: Event) => {
      event.preventDefault();
      latest.current.onError("The graphics context was lost. Reload the page to restore the organ viewer.");
    };
    renderer.domElement.addEventListener("webglcontextlost", contextLost);
    runtime.current = { renderer, group, controls, camera, fit, view, cancelDrag };
    animate();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      cancelDrag();
      canvas.removeEventListener("pointerdown", down, true);
      canvas.removeEventListener("pointermove", move, true);
      canvas.removeEventListener("pointerup", up, true);
      canvas.removeEventListener("pointercancel", cancelPointer);
      canvas.removeEventListener("lostpointercapture", cancelPointer);
      canvas.removeEventListener("pointerleave", leave);
      window.removeEventListener("keydown", escape);
      marker.geometry.dispose(); marker.material.dispose();
      resize.disconnect();
      controls.dispose();
      disposeMeshes(group);
      environment.dispose();
      renderer.domElement.removeEventListener("webglcontextlost", contextLost);
      renderer.dispose();
      renderer.domElement.remove();
      runtime.current = null;
    };
  }, []);

  useEffect(() => {
    const state = runtime.current;
    if (!state || !props.scene) return;
    const shouldFit = props.fitKey === undefined || state.group.children.length === 0 || state.framingKey !== props.fitKey;
    state.cancelDrag();
    disposeMeshes(state.group);
    photoMaterials.current = [];
    let vertices = 0;
    let triangles = 0;
    for (const organ of [...props.scene.organs, ...(props.scene.vessels ?? [])]) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(organ.positions, 3));
      geometry.setIndex(organ.indices);
      if (organ.normals) geometry.setAttribute("normal", new THREE.Float32BufferAttribute(organ.normals, 3));
      else geometry.computeVertexNormals();
      if (organ.colors) {
        const colors = new Float32Array(organ.colors.length);
        const color = new THREE.Color();
        for (let i = 0; i < colors.length; i += 3) {
          color.setRGB(organ.colors[i]!, organ.colors[i + 1]!, organ.colors[i + 2]!, THREE.SRGBColorSpace);
          colors[i] = color.r; colors[i + 1] = color.g; colors[i + 2] = color.b;
        }
        geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      }
      geometry.computeBoundingSphere();
      const material = new THREE.MeshPhysicalMaterial({
        color: organ.colors ? "#ffffff" : organ.color,
        vertexColors: Boolean(organ.colors),
        roughness: 0.5, metalness: 0, clearcoat: 0.12, clearcoatRoughness: 0.3,
        side: THREE.DoubleSide, envMapIntensity: 0.2,
      });
      const materialV2 = props.appearance === "tissue" ? readAtlasMaterial(organ, props.scene) : null;
      if (materialV2) installAtlasMaterial(geometry, material, materialV2);
      if (materialV2) {
        material.userData.photoOrgan = organ.id; photoMaterials.current.push(material);
        // the photo-detail effect above ran for this scene before these materials existed: install the layer here too
        if (photoStrength > 0) void photoDetailFor(organ.id).then((detail) => { if (photoMaterials.current.includes(material)) installPhotoDetail(material, detail, photoStrength, photoRelief); }).catch(() => {});
      }
      const vessels = organ.metadata?.surface_vessels as AtlasVesselNetwork | undefined;
      if (props.appearance === "tissue" && vessels) {
        if (!geometry.hasAttribute("atlasRestPosition")) {
          const fields = organ as typeof organ & { rest_positions?: number[]; sculpt_reference_positions?: number[] };
          geometry.setAttribute("atlasRestPosition", new THREE.Float32BufferAttribute(fields.rest_positions ?? fields.sculpt_reference_positions ?? organ.positions, 3));
        }
        installAtlasVessels(geometry, material, vessels);
      }
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = organ.name;
      mesh.userData.organId = organ.id;
      mesh.userData.guardPositions = (organ as typeof organ & { sculpt_reference_positions?: number[] }).sculpt_reference_positions ?? organ.positions;
      mesh.userData.sculptable = props.scene.organs.includes(organ);
      mesh.userData.baseColor = organ.colors ? "#ffffff" : organ.color;
      mesh.userData.hasVertexColors = Boolean(organ.colors);
      mesh.userData.materialDefinition = organ.metadata?.appearance ?? props.scene.metadata?.appearance;
      if (materialV2) mesh.userData.materialV2 = true;
      state.group.add(mesh);
      vertices += organ.positions.length / 3;
      triangles += organ.indices.length / 3;
    }
    if (shouldFit) state.fit();
    state.framingKey = props.fitKey;
    const size = new THREE.Box3().setFromObject(state.group).getSize(new THREE.Vector3());
    latest.current.onStats({ vertices, triangles, extentMm: [size.x, size.y, size.z] });
  }, [props.scene, props.fitKey]);

  useEffect(() => {
    const state = runtime.current;
    if (!state) return;
    for (const child of state.group.children) {
      if (!(child instanceof THREE.Mesh) || !(child.material instanceof THREE.MeshPhysicalMaterial)) continue;
      const material = child.material;
      if (child.userData.materialV2) {
        material.wireframe = props.wireframe;
        material.needsUpdate = true;
        continue;
      }
      const clay = props.appearance === "clay";
      // All appearance colors come from the realized API artifact, including
      // clay. Preserve them so browser screenshots and exported GLB agree.
      material.color.set(child.userData.baseColor as string);
      material.vertexColors = Boolean(child.userData.hasVertexColors);
      const definition: unknown = child.userData.materialDefinition;
      material.roughness = materialValue(definition, "roughness", clay ? 0.83 : props.appearance === "source" ? 0.65 : 0.48);
      material.clearcoat = materialValue(definition, "clearcoat", props.appearance === "tissue" ? 0.12 : 0);
      material.clearcoatRoughness = materialValue(definition, "clearcoat_roughness", 0.3);
      material.metalness = materialValue(definition, "metalness", 0);
      material.wireframe = props.wireframe;
      material.needsUpdate = true;
    }
  }, [props.scene, props.appearance, props.wireframe]);

  useEffect(() => {
    const state = runtime.current;
    if (!state) return;
    if (!props.sculptEnabled) state.cancelDrag();
    state.controls.enableDamping = !props.sculptEnabled;
    state.controls.mouseButtons.RIGHT = props.sculptEnabled ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN;
    state.controls.update();
  }, [props.sculptEnabled]);

  return <div className="atlas-viewport-canvas" ref={host} data-testid="atlas-viewport" aria-label="Interactive atlas organ preview" />;
});
