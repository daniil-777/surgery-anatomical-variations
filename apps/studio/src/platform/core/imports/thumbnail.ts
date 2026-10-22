// A 512 × 512 still of the display scene, rendered off-screen: a detached canvas with its own WebGL context, drawn at
// twice the size and scaled down (smooth edges on thin parts), RoomEnvironment image-based lighting with a key and a
// rim light, a camera fitted to the model's own vertices from a three-quarter view, and the render composited over a
// neutral backdrop with a soft contact shadow. The renderer and its context are released at once. Browser-only;
// elsewhere the result is null with a note.

import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { isPlatformError } from "../types";
import { errorMessage, throwIfAborted } from "./errors";
import { IMPORT_LIMITS } from "./limits";

export interface Thumbnail {
  /** WebP where the browser can encode it, else PNG; null when nothing could be rendered. */
  blob: Blob | null;
  note: string | null;
}

/** Behind the model: a neutral grey, the same in light and dark appearance, with contrast for white and black models. */
const BACKDROP_CENTER = "#e4e6ea";
const BACKDROP_EDGE = "#b7bcc4";
/** Rendered at this multiple of the output size, then scaled down. */
const SUPERSAMPLE = 2;
/** Share of the frame the model may fill. */
const FILL = 0.84;
/** From the model towards the camera: in front, to the right and above, as product shots are taken. */
const VIEW_DIRECTION = new THREE.Vector3(0.72, 0.48, 1).normalize();
/** Vertices sampled for framing (evenly strided over every mesh). */
const MAX_SAMPLES = 60_000;

export interface Framing {
  /** Point the camera looks at. */
  target: THREE.Vector3;
  /** Distance from the target along the view direction. */
  distance: number;
  near: number;
  far: number;
  /** Camera basis: right, up and back (towards the camera). */
  right: THREE.Vector3;
  up: THREE.Vector3;
  back: THREE.Vector3;
}

function isRenderable(node: THREE.Object3D): node is THREE.Mesh | THREE.Points | THREE.Line {
  return (node as THREE.Mesh).isMesh === true || (node as THREE.Points).isPoints === true || (node as THREE.Line).isLine === true;
}

/** World positions of up to `limit` vertices of the visible meshes, points and lines (skinning and morph targets applied). */
export function samplePoints(root: THREE.Object3D, limit = MAX_SAMPLES): Float32Array {
  root.updateMatrixWorld(true);
  const sources: Array<THREE.Mesh | THREE.Points | THREE.Line> = [];
  let total = 0;
  root.traverseVisible((node) => {
    if (!isRenderable(node)) return;
    const position = node.geometry?.getAttribute("position");
    if (!position) return;
    if (node instanceof THREE.SkinnedMesh) node.skeleton.update();
    sources.push(node);
    total += position.count * (node instanceof THREE.InstancedMesh ? node.count : 1);
  });
  const stride = Math.max(1, Math.ceil(total / limit));
  const out = new Float32Array(Math.ceil(total / stride) * 3 + 3);
  const vertex = new THREE.Vector3();
  const instance = new THREE.Matrix4();
  const world = new THREE.Matrix4();
  let counter = 0;
  let length = 0;
  for (const node of sources) {
    const position = node.geometry.getAttribute("position");
    const instances = node instanceof THREE.InstancedMesh ? node.count : 1;
    for (let k = 0; k < instances; k++) {
      if (node instanceof THREE.InstancedMesh) {
        node.getMatrixAt(k, instance);
        world.multiplyMatrices(node.matrixWorld, instance);
      } else {
        world.copy(node.matrixWorld);
      }
      for (let i = 0; i < position.count; i++) {
        if (counter++ % stride !== 0) continue;
        if (node instanceof THREE.Mesh) node.getVertexPosition(i, vertex);
        else vertex.fromBufferAttribute(position, i);
        vertex.applyMatrix4(world);
        if (!Number.isFinite(vertex.x) || !Number.isFinite(vertex.y) || !Number.isFinite(vertex.z) || length + 3 > out.length) continue;
        out[length++] = vertex.x;
        out[length++] = vertex.y;
        out[length++] = vertex.z;
      }
    }
  }
  return out.subarray(0, length);
}

/**
 * The camera placement that shows every point inside `fill` of a square frame, centred on screen (perspective
 * included), looking along -`direction`. Null when the points have no extent.
 */
export function frameView(points: Float32Array, fovDegrees: number, direction: THREE.Vector3 = VIEW_DIRECTION, fill = FILL): Framing | null {
  const count = Math.floor(points.length / 3);
  if (count === 0) return null;
  const back = direction.clone().normalize();
  const right = new THREE.Vector3(0, 1, 0).cross(back);
  if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
  right.normalize();
  const up = new THREE.Vector3().crossVectors(back, right).normalize();
  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  const zs = new Float64Array(count);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    const px = points[i * 3]!;
    const py = points[i * 3 + 1]!;
    const pz = points[i * 3 + 2]!;
    const x = px * right.x + py * right.y + pz * right.z;
    const y = px * up.x + py * up.y + pz * up.z;
    const z = px * back.x + py * back.y + pz * back.z;
    xs[i] = x;
    ys[i] = y;
    zs[i] = z;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
  if (!(extent > 0) || !Number.isFinite(extent)) return null;
  const tan = Math.tan(THREE.MathUtils.degToRad(fovDegrees / 2)) * fill;
  let cx = (minX + maxX) / 2;
  let cy = (minY + maxY) / 2;
  const cz = (minZ + maxZ) / 2;
  let distance = 0;
  // Two passes: fit the distance, then move the centre so the perspective silhouette sits in the middle, then refit.
  for (let pass = 0; pass < 2; pass++) {
    distance = 0;
    for (let i = 0; i < count; i++) {
      distance = Math.max(distance, zs[i]! - cz + Math.max(Math.abs(xs[i]! - cx), Math.abs(ys[i]! - cy)) / tan);
    }
    if (pass === 1) break;
    let lowX = Infinity;
    let highX = -Infinity;
    let lowY = Infinity;
    let highY = -Infinity;
    for (let i = 0; i < count; i++) {
      const depth = Math.max(cz + distance - zs[i]!, extent * 1e-6);
      const sx = (xs[i]! - cx) / depth;
      const sy = (ys[i]! - cy) / depth;
      lowX = Math.min(lowX, sx);
      highX = Math.max(highX, sx);
      lowY = Math.min(lowY, sy);
      highY = Math.max(highY, sy);
    }
    cx += ((lowX + highX) / 2) * distance;
    cy += ((lowY + highY) / 2) * distance;
  }
  const target = new THREE.Vector3().addScaledVector(right, cx).addScaledVector(up, cy).addScaledVector(back, cz);
  const nearest = cz + distance - maxZ;
  const farthest = cz + distance - minZ;
  return {
    target,
    distance,
    near: Math.max(nearest * 0.8, distance / 1000),
    far: farthest * 1.25 + extent * 0.01,
    right,
    up,
    back,
  };
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** A soft elliptical shadow on the ground plane under the model (the lowest point), drawn in screen space. */
function drawContactShadow(context: CanvasRenderingContext2D, points: Float32Array, camera: THREE.PerspectiveCamera, size: number): void {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i + 2 < points.length; i += 3) {
    minX = Math.min(minX, points[i]!);
    maxX = Math.max(maxX, points[i]!);
    minY = Math.min(minY, points[i + 1]!);
    minZ = Math.min(minZ, points[i + 2]!);
    maxZ = Math.max(maxZ, points[i + 2]!);
  }
  if (![minX, maxX, minY, minZ, maxZ].every(Number.isFinite)) return;
  const forward = camera.getWorldDirection(new THREE.Vector3());
  const floor = [
    new THREE.Vector3(minX, minY, minZ),
    new THREE.Vector3(maxX, minY, minZ),
    new THREE.Vector3(maxX, minY, maxZ),
    new THREE.Vector3(minX, minY, maxZ),
  ];
  // A floor corner behind the camera (a camera inside a huge flat model) would project mirrored: no shadow then.
  if (floor.some((corner) => corner.clone().sub(camera.position).dot(forward) <= 0)) return;
  const corners = floor.map((corner) => corner.project(camera));
  if (corners.some((corner) => !Number.isFinite(corner.x) || !Number.isFinite(corner.y))) return;
  const xs = corners.map((corner) => ((corner.x + 1) / 2) * size);
  const ys = corners.map((corner) => ((1 - corner.y) / 2) * size);
  const centerX = xs.reduce((sum, value) => sum + value, 0) / 4;
  const centerY = ys.reduce((sum, value) => sum + value, 0) / 4;
  const radiusX = Math.max((Math.max(...xs) - Math.min(...xs)) * 0.56, size * 0.04);
  const radiusY = Math.max((Math.max(...ys) - Math.min(...ys)) * 0.56, size * 0.012);
  context.save();
  context.translate(centerX, centerY);
  context.scale(1, radiusY / radiusX);
  const gradient = context.createRadialGradient(0, 0, 0, 0, 0, radiusX);
  gradient.addColorStop(0, "rgba(24, 28, 36, 0.26)");
  gradient.addColorStop(0.55, "rgba(24, 28, 36, 0.12)");
  gradient.addColorStop(1, "rgba(24, 28, 36, 0)");
  context.fillStyle = gradient;
  context.beginPath();
  context.arc(0, 0, radiusX, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

export async function renderThumbnail(scene: THREE.Object3D, options: { size?: number; signal?: AbortSignal | undefined } = {}): Promise<Thumbnail> {
  const size = options.size ?? IMPORT_LIMITS.thumbnailSize;
  throwIfAborted(options.signal);
  if (typeof document === "undefined") return { blob: null, note: "No thumbnail was rendered (no WebGL in this environment)." };

  const points = samplePoints(scene);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 1000);
  const framing = frameView(points, camera.fov);
  if (!framing) return { blob: null, note: "No thumbnail was rendered (the model has no visible extent)." };
  camera.position.copy(framing.target).addScaledVector(framing.back, framing.distance);
  camera.up.copy(framing.up);
  camera.near = framing.near;
  camera.far = framing.far;
  camera.lookAt(framing.target);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);

  const renderSize = size * SUPERSAMPLE;
  const canvas = document.createElement("canvas");
  canvas.width = renderSize;
  canvas.height = renderSize;
  // Ask for the context first: three.js logs a console error when it cannot create one itself.
  const context = canvas.getContext("webgl2", {
    alpha: true,
    antialias: true,
    depth: true,
    stencil: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: true,
    powerPreference: "low-power",
  });
  if (!context) return { blob: null, note: "No thumbnail was rendered (WebGL is unavailable in this browser)." };

  let renderer: THREE.WebGLRenderer | null = null;
  let pmrem: THREE.PMREMGenerator | null = null;
  let environment: THREE.WebGLRenderTarget | null = null;
  const room = new RoomEnvironment();
  const stage = new THREE.Scene();
  const parent = scene.parent;
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  const rim = new THREE.DirectionalLight(0xffffff, 0.9);
  const sky = new THREE.HemisphereLight(0xffffff, 0x8e9196, 0.35);
  try {
    renderer = new THREE.WebGLRenderer({ canvas, context, antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(renderSize, renderSize, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Khronos PBR Neutral keeps texture colours as authored (ACES shifts hues and darkens saturated colours).
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.setClearColor(0x000000, 0);
    pmrem = new THREE.PMREMGenerator(renderer);
    environment = pmrem.fromScene(room, 0.04);
    stage.environment = environment.texture;
    // RoomEnvironment at full strength flattens shading on light materials; the lights below shape the form.
    stage.environmentIntensity = 0.55;
    stage.add(scene);
    const { target, distance, right, up, back } = framing;
    // Key light above-left of the camera, rim light from behind on the right: it separates the outline from the backdrop.
    key.position.copy(target).addScaledVector(right, -0.6 * distance).addScaledVector(up, 0.9 * distance).addScaledVector(back, 0.6 * distance);
    rim.position.copy(target).addScaledVector(right, 0.8 * distance).addScaledVector(up, 0.35 * distance).addScaledVector(back, -0.8 * distance);
    for (const light of [key, rim]) {
      light.target.position.copy(target);
      stage.add(light, light.target);
    }
    stage.add(sky);
    renderer.render(stage, camera);
    throwIfAborted(options.signal);

    const output = document.createElement("canvas");
    output.width = size;
    output.height = size;
    const context2d = output.getContext("2d");
    if (!context2d) return { blob: null, note: "No thumbnail was rendered (no 2D canvas)." };
    const backdrop = context2d.createRadialGradient(size / 2, size * 0.4, size * 0.05, size / 2, size / 2, size * 0.78);
    backdrop.addColorStop(0, BACKDROP_CENTER);
    backdrop.addColorStop(1, BACKDROP_EDGE);
    context2d.fillStyle = backdrop;
    context2d.fillRect(0, 0, size, size);
    drawContactShadow(context2d, points, camera, size);
    context2d.imageSmoothingEnabled = true;
    context2d.imageSmoothingQuality = "high";
    context2d.drawImage(canvas, 0, 0, renderSize, renderSize, 0, 0, size, size);
    const blob = (await canvasToBlob(output, "image/webp", 0.86)) ?? (await canvasToBlob(output, "image/png", 1));
    return blob ? { blob, note: null } : { blob: null, note: "No thumbnail was rendered (the browser could not encode the image)." };
  } catch (error) {
    if (isPlatformError(error, "aborted")) throw error;
    return { blob: null, note: `No thumbnail was rendered (${errorMessage(error)}).` };
  } finally {
    stage.remove(scene);
    if (parent) parent.add(scene);
    for (const light of [key, rim]) {
      stage.remove(light, light.target);
      light.dispose();
    }
    stage.remove(sky);
    sky.dispose();
    environment?.dispose();
    pmrem?.dispose();
    room.dispose();
    if (renderer) {
      renderer.dispose();
      renderer.forceContextLoss();
    }
  }
}
