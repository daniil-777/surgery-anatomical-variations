// The three.js side of ModelViewer, loaded only through import() so the shell's first chunk carries no three.js. One
// stage = one WebGL context: GLTFLoader with the meshopt decoder, RoomEnvironment image-based lighting through PMREM,
// OrbitControls with damping, a camera fitted to the model's bounds, an optional turntable, wireframe, and rendering on
// demand (the loop runs only while something moves and the stage is on screen). dispose() frees every geometry,
// material, texture and the context itself.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { PlatformError } from "../../core/types";
import { ModelViewError } from "./modelErrors";

export interface ModelStats {
  vertices: number;
  triangles: number;
  meshes: number;
}

export interface StageCallbacks {
  onContextLost?: (() => void) | undefined;
  onContextRestored?: (() => void) | undefined;
}

/** A GLB as bytes: fetched (with the signal) from a URL, or read from a Blob. */
export async function readModelBytes(source: { kind: "url"; url: string } | { kind: "blob"; blob: Blob }, signal?: AbortSignal): Promise<ArrayBuffer> {
  if (source.kind === "blob") return source.blob.arrayBuffer();
  let response: Response;
  try {
    response = await fetch(source.url, signal ? { signal } : {});
  } catch (error) {
    if (signal?.aborted) throw new PlatformError("aborted", "Cancelled.", { cause: error });
    throw new PlatformError("network", "The model could not be downloaded.", { cause: error });
  }
  if (!response.ok) throw new PlatformError(response.status === 404 || response.status === 400 ? "not_found" : "network", "The model could not be downloaded.", { status: response.status });
  return response.arrayBuffer();
}

/** Vertices, triangles and meshes as drawn (instanced meshes count every instance). */
export function countModelStats(root: THREE.Object3D): ModelStats {
  let vertices = 0;
  let triangles = 0;
  let meshes = 0;
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geometry = mesh.geometry as THREE.BufferGeometry | undefined;
    const position = geometry?.getAttribute("position");
    if (!geometry || !position) return;
    const instanced = object as THREE.InstancedMesh;
    const instances = instanced.isInstancedMesh ? instanced.count : 1;
    const drawn = Math.min(geometry.index ? geometry.index.count : position.count, geometry.drawRange.count);
    meshes += 1;
    vertices += position.count * instances;
    triangles += Math.floor(drawn / 3) * instances;
  });
  return { vertices, triangles, meshes };
}

/** Frees the GPU and decoded-image memory of everything under `root`. */
export function disposeObject(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  root.traverse((object) => {
    const drawable = object as THREE.Object3D & { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] };
    if (drawable.geometry) geometries.add(drawable.geometry);
    const material = drawable.material;
    if (Array.isArray(material)) for (const entry of material) materials.add(entry);
    else if (material) materials.add(material);
    const skinned = object as THREE.SkinnedMesh;
    if (skinned.isSkinnedMesh) skinned.skeleton?.dispose();
  });
  const textures = new Set<THREE.Texture>();
  for (const material of materials) {
    for (const value of Object.values(material) as unknown[]) {
      if (value && typeof value === "object" && (value as THREE.Texture).isTexture) textures.add(value as THREE.Texture);
    }
    material.dispose();
  }
  for (const texture of textures) {
    const data: unknown = texture.source?.data;
    texture.dispose();
    // GLTFLoader decodes into ImageBitmaps in Chromium and Firefox: close them, or the decoded pixels stay in memory
    if (typeof ImageBitmap !== "undefined" && data instanceof ImageBitmap) data.close();
  }
  for (const geometry of geometries) geometry.dispose();
}

const VIEW_DIRECTION = new THREE.Vector3(0.85, 0.55, 1.2).normalize();
const KEY_STEP = THREE.MathUtils.degToRad(10);

export class ModelStage {
  readonly canvas: HTMLCanvasElement;
  private readonly host: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
  private readonly controls: OrbitControls;
  private readonly pmrem: THREE.PMREMGenerator;
  private readonly environment: THREE.WebGLRenderTarget;
  private readonly room = new RoomEnvironment();
  private readonly keyLight = new THREE.DirectionalLight(0xffffff, 1.1);
  private readonly resizeObserver: ResizeObserver | null;
  private readonly intersectionObserver: IntersectionObserver | null;
  private readonly callbacks: StageCallbacks;
  private model: THREE.Object3D | null = null;
  private readonly wireframeOriginal = new WeakMap<THREE.Material, boolean>();
  private wireframe = false;
  private onScreen = true;
  private looping = false;
  private idleFrames = 0;
  private lastTime = 0;
  private needsRender = true;
  private lost = false;
  private disposed = false;

  constructor(host: HTMLElement, callbacks: StageCallbacks = {}) {
    this.host = host;
    this.callbacks = callbacks;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "px-model-viewer__canvas";
    this.canvas.setAttribute("aria-hidden", "true");
    // ask for the context first: three.js logs a console error when it cannot create one itself
    const context = this.canvas.getContext("webgl2", { alpha: true, antialias: true, depth: true, stencil: false, premultipliedAlpha: true, powerPreference: "default" });
    if (!context) throw new ModelViewError("3D previews need WebGL, which isn’t available in this browser right now.");
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, context, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.setClearColor(0x000000, 0);
    host.append(this.canvas);

    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.environment = this.pmrem.fromScene(this.room, 0.04);
    this.scene.environment = this.environment.texture;
    this.scene.environmentIntensity = 0.85;
    // a key light that travels with the camera keeps form readable from every side
    this.keyLight.position.set(-1.2, 2, 1.5);
    this.camera.add(this.keyLight);
    this.scene.add(this.camera);

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.autoRotateSpeed = 2;
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener("start", this.wake);
    this.controls.addEventListener("change", this.wake);

    this.canvas.addEventListener("webglcontextlost", this.onContextLost);
    this.canvas.addEventListener("webglcontextrestored", this.onContextRestored);
    document.addEventListener("visibilitychange", this.onVisibility);

    this.resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => this.resize());
    this.resizeObserver?.observe(host);
    this.intersectionObserver =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver((entries) => {
            this.onScreen = entries.some((entry) => entry.isIntersecting);
            if (this.onScreen) this.wake();
            else this.stopLoop();
          });
    this.intersectionObserver?.observe(host);
    this.resize();
  }

  /** Parses a GLB and shows it framed. Resolves with its stats; a newer load or dispose() aborts it. */
  async load(bytes: ArrayBuffer, signal?: AbortSignal): Promise<ModelStats> {
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const gltf = await loader.parseAsync(bytes, "");
    const root = gltf.scene ?? gltf.scenes?.[0];
    if (!root) throw new ModelViewError("This model has no scene to show.");
    if (signal?.aborted || this.disposed) {
      disposeObject(root);
      throw new PlatformError("aborted", "Cancelled.");
    }
    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root, true);
    if (box.isEmpty() || !Number.isFinite(box.min.x) || !Number.isFinite(box.max.x)) {
      disposeObject(root);
      throw new ModelViewError("This model has nothing to show.");
    }
    this.clear();
    this.model = root;
    this.scene.add(root);
    this.applyWireframe();
    this.frame();
    return countModelStats(root);
  }

  /** Removes and frees the current model. */
  clear(): void {
    if (!this.model) return;
    this.scene.remove(this.model);
    disposeObject(this.model);
    this.model = null;
    this.requestRender();
  }

  setAutoRotate(on: boolean): void {
    this.controls.autoRotate = on;
    if (on) this.wake();
  }

  setWireframe(on: boolean): void {
    if (this.wireframe === on) return;
    this.wireframe = on;
    this.applyWireframe();
    this.requestRender();
  }

  /** Fits the camera to the model from a three-quarter view (also the "F" key). */
  frame(): void {
    if (!this.model) return;
    const box = new THREE.Box3().setFromObject(this.model, true);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const radius = Number.isFinite(sphere.radius) && sphere.radius > 0 ? sphere.radius : 1;
    const halfFov = THREE.MathUtils.degToRad(this.camera.fov / 2);
    const fitHeight = radius / Math.sin(halfFov);
    const fitWidth = radius / Math.sin(Math.atan(Math.tan(halfFov) * Math.max(this.camera.aspect, 1e-3)));
    const distance = Math.max(fitHeight, fitWidth) * 1.08;
    this.camera.position.copy(sphere.center).addScaledVector(VIEW_DIRECTION, distance);
    this.camera.near = Math.max(radius / 200, distance / 1000);
    this.camera.far = distance + radius * 40;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(sphere.center);
    this.controls.minDistance = radius * 0.25;
    this.controls.maxDistance = distance * 8;
    this.controls.update();
    this.requestRender();
  }

  /** Keyboard orbit: whole steps of 10°, as the arrow keys do. */
  orbit(left: number, up: number): void {
    if (left !== 0) this.controls.rotateLeft(left * KEY_STEP);
    if (up !== 0) this.controls.rotateUp(up * KEY_STEP);
    this.wake();
  }

  /** Keyboard zoom: factor > 1 moves closer. */
  zoom(factor: number): void {
    if (!this.model || !(factor > 0)) return;
    const offset = this.camera.position.clone().sub(this.controls.target);
    const length = THREE.MathUtils.clamp(offset.length() / factor, this.controls.minDistance, this.controls.maxDistance);
    this.camera.position.copy(this.controls.target).addScaledVector(offset.normalize(), length);
    this.controls.update();
    this.requestRender();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopLoop();
    this.resizeObserver?.disconnect();
    this.intersectionObserver?.disconnect();
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.controls.removeEventListener("start", this.wake);
    this.controls.removeEventListener("change", this.wake);
    this.controls.dispose();
    if (this.model) {
      this.scene.remove(this.model);
      disposeObject(this.model);
      this.model = null;
    }
    this.camera.remove(this.keyLight);
    this.keyLight.dispose();
    this.scene.environment = null;
    this.environment.dispose();
    this.pmrem.dispose();
    this.room.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
    this.canvas.remove();
  }

  private applyWireframe(): void {
    this.model?.traverse((object) => {
      const material = (object as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      for (const entry of Array.isArray(material) ? material : material ? [material] : []) {
        const editable = entry as THREE.Material & { wireframe?: boolean };
        if (typeof editable.wireframe !== "boolean") continue;
        if (!this.wireframeOriginal.has(entry)) this.wireframeOriginal.set(entry, editable.wireframe);
        editable.wireframe = this.wireframe ? true : (this.wireframeOriginal.get(entry) ?? false);
      }
    });
  }

  private resize(): void {
    if (this.disposed) return;
    const width = Math.max(1, Math.round(this.host.clientWidth));
    const height = Math.max(1, Math.round(this.host.clientHeight));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  private requestRender(): void {
    this.needsRender = true;
    this.startLoop();
  }

  private readonly wake = (): void => {
    this.idleFrames = 0;
    this.requestRender();
  };

  private startLoop(): void {
    if (this.looping || this.disposed || this.lost || !this.onScreen || document.hidden) return;
    this.looping = true;
    this.lastTime = performance.now();
    this.renderer.setAnimationLoop(this.tick);
  }

  private stopLoop(): void {
    if (!this.looping) return;
    this.looping = false;
    this.renderer.setAnimationLoop(null);
  }

  private readonly tick = (time: number): void => {
    if (this.disposed || this.lost) return;
    const delta = Math.min(0.1, Math.max(0, (time - this.lastTime) / 1000));
    this.lastTime = time;
    const moved = this.controls.update(delta);
    if (moved || this.needsRender) {
      this.needsRender = false;
      this.idleFrames = 0;
      this.renderer.render(this.scene, this.camera);
    } else if (!this.controls.autoRotate && ++this.idleFrames > 20) {
      // nothing moved for a moment: sleep until the next interaction
      this.stopLoop();
    }
  };

  private readonly onVisibility = (): void => {
    if (document.hidden) this.stopLoop();
    else this.wake();
  };

  private readonly onContextLost = (event: Event): void => {
    // preventDefault lets the browser restore the context later
    event.preventDefault();
    this.lost = true;
    this.stopLoop();
    this.callbacks.onContextLost?.();
  };

  private readonly onContextRestored = (): void => {
    this.lost = false;
    this.callbacks.onContextRestored?.();
    this.wake();
  };
}
