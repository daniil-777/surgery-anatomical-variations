import {
  ACESFilmicToneMapping, BufferAttribute, BufferGeometry, CanvasTexture, Color, DirectionalLight,
  DoubleSide, DynamicDrawUsage, Mesh, MeshPhysicalMaterial, MeshStandardMaterial, OrthographicCamera,
  PerspectiveCamera, PlaneGeometry, PMREMGenerator, Scene, Sprite, SpriteMaterial, SRGBColorSpace,
  Vector3, WebGLRenderer, type WebGLRenderTarget,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { registerSceneRecordingSource } from "../../sceneRecordingSource";
import { filmGeometryData } from "./geometry";
import type { FilmSnapshot } from "./solver";

/** Scientific extrusion of a 1D periodic film. Thickness and normals use physical
 * geometry; spectral slab colours are an approximation under neutral lighting.
 */
export class CapillaryRenderer {
  readonly canvas: HTMLCanvasElement;
  private readonly gpu: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(35, 1, .005, 200);
  private controls?: OrbitControls;
  private observer?: ResizeObserver;
  private recording?: ReturnType<typeof registerSceneRecordingSource>;
  private environment?: WebGLRenderTarget;
  private readonly geometry = new BufferGeometry();
  private readonly material = new MeshPhysicalMaterial({
    color: 0xffffff, vertexColors: true, roughness: .14, metalness: 0, ior: 1.35, side: DoubleSide,
  });
  private readonly substrateGeometry: PlaneGeometry;
  private readonly substrateMaterial = new MeshStandardMaterial({ color: new Color().setRGB(.72, .72, .72), roughness: .8 });
  private readonly overlay = new Scene();
  private readonly overlayCamera = new OrthographicCamera(0, 1, 1, 0, 0, 2);
  private readonly labelTexture: CanvasTexture;
  private readonly label: Sprite;
  private readonly home = new Vector3(1.2, 3.6, 6.3);
  private detachAbort: (() => void) | undefined;
  private fit = 1;
  private dirty = true;
  private lost = false;
  private disposed = false;
  private lastTime = -1;

  constructor(private readonly host: HTMLElement, private readonly options: {
    lengthM: number; widthM: number; onError(message: string): void;
  }) {
    if (![options.lengthM, options.widthM].every(v => Number.isFinite(v) && v > 0)) throw new RangeError("Invalid film dimensions");
    this.gpu = new WebGLRenderer({ antialias: true, alpha: false });
    this.canvas = this.gpu.domElement;
    this.substrateGeometry = new PlaneGeometry(options.lengthM * 1000 + .15, options.widthM * 1000 + .15);
    const labelCanvas = document.createElement("canvas"); labelCanvas.width = 1400; labelCanvas.height = 210;
    const ctx = labelCanvas.getContext("2d")!;
    ctx.fillStyle = "rgba(12,20,29,.9)"; ctx.fillRect(0, 0, 1400, 210);
    ctx.fillStyle = "#f2f4f6"; ctx.font = "500 45px sans-serif";
    ctx.fillText(`1D FILM  ·  ${options.lengthM * 1000} × ${options.widthM * 1000} mm`, 36, 70);
    ctx.fillStyle = "#bac6d0"; ctx.font = "34px sans-serif";
    ctx.fillText("True height · periodic x · approximate spectral optics", 36, 137);
    this.labelTexture = new CanvasTexture(labelCanvas); this.labelTexture.colorSpace = SRGBColorSpace;
    this.label = new Sprite(new SpriteMaterial({ map: this.labelTexture, depthTest: false, depthWrite: false, toneMapped: false }));
    this.label.center.set(0, 1); this.overlay.add(this.label); this.overlayCamera.position.z = 1;
    try {
      this.canvas.tabIndex = 0;
      this.canvas.setAttribute("aria-label", "Thin film at true physical scale. Drag or use arrows to orbit, plus and minus to zoom, Home to reset.");
      this.canvas.style.cssText = "display:block;width:100%;height:100%;touch-action:none";
      host.appendChild(this.canvas);
      this.gpu.outputColorSpace = SRGBColorSpace; this.gpu.toneMapping = ACESFilmicToneMapping;
      this.scene.background = new Color("#131c26");
      const room = new RoomEnvironment(), pmrem = new PMREMGenerator(this.gpu);
      try { this.environment = pmrem.fromScene(room, .04); this.scene.environment = this.environment.texture; }
      finally { room.dispose(); pmrem.dispose(); }
      this.scene.environmentIntensity = .8;
      const light = new DirectionalLight(0xffffff, 2); light.position.set(-2, 4, 3); this.scene.add(light);
      const substrate = new Mesh(this.substrateGeometry, this.substrateMaterial); substrate.rotation.x = -Math.PI / 2;
      substrate.position.y = -.001; this.scene.add(substrate, new Mesh(this.geometry, this.material));
      this.camera.position.copy(this.home);
      this.controls = new OrbitControls(this.camera, this.canvas);
      this.controls.minDistance = .8; this.controls.maxDistance = 40; this.controls.maxPolarAngle = Math.PI * .49;
      this.controls.enableDamping = false; this.controls.update(); this.controls.saveState();
      this.controls.addEventListener("change", this.changed);
      this.canvas.addEventListener("keydown", this.key);
      this.canvas.addEventListener("webglcontextlost", this.contextLost);
      this.recording = registerSceneRecordingSource({ renderer: this.gpu, camera: this.camera, host,
        label: "Capillary film · 1D periodic reference", draw: () => this.render(), available: () => !this.lost && !this.disposed });
      const prepare = this.recording.source.prepare.bind(this.recording.source);
      this.recording.source.prepare = target => {
        const lease = prepare(target); let restored = false;
        const detach = () => { target.signal.removeEventListener("abort", restore); this.detachAbort = undefined; };
        const restore = () => { if (restored) return; restored = true; detach(); lease.restore(); this.resize(); };
        this.detachAbort = detach; target.signal.addEventListener("abort", restore, { once: true });
        return { restore };
      };
      this.observer = new ResizeObserver(this.resize); this.observer.observe(host); this.resize();
    } catch (error) { this.dispose(); throw error; }
  }
  private readonly changed = () => { this.dirty = true; };
  private readonly resize = () => {
    if (this.disposed || this.lost || this.recording?.active) return;
    const w = Math.max(16, this.host.clientWidth), h = Math.max(16, this.host.clientHeight), fit = Math.max(1, 1.7 / (w / h));
    this.gpu.setPixelRatio(Math.min(devicePixelRatio, 2)); this.gpu.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.position.sub(this.controls!.target).multiplyScalar(fit / this.fit).add(this.controls!.target); this.fit = fit;
    this.camera.updateProjectionMatrix(); this.controls!.update(); this.dirty = true;
  };
  private readonly key = (event: KeyboardEvent) => {
    if (!this.controls || this.lost || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "=", "-", "Home"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Home") { this.controls.reset(); this.camera.position.copy(this.home).multiplyScalar(this.fit); }
    if (event.key === "ArrowLeft") this.controls.rotateLeft(.1);
    if (event.key === "ArrowRight") this.controls.rotateLeft(-.1);
    if (event.key === "ArrowUp") this.controls.rotateUp(.1);
    if (event.key === "ArrowDown") this.controls.rotateUp(-.1);
    // OrbitControls multiplies by the "in" factor and divides for "out".
    if (event.key === "+" || event.key === "=") this.controls.dollyIn(1 / 1.1);
    if (event.key === "-") this.controls.dollyOut(1 / 1.1);
    this.controls.update(); this.dirty = true;
  };
  private readonly contextLost = (event: Event) => {
    event.preventDefault(); if (this.disposed || this.lost) return;
    this.lost = true; if (this.controls) this.controls.enabled = false;
    this.detachAbort?.(); this.options.onError("Film graphics context lost. Reset to recover.");
  };
  update(snapshot: Pick<FilmSnapshot, "heightM" | "timeSeconds">) {
    if (this.disposed || this.lost) return;
    if (!Number.isFinite(snapshot.timeSeconds) || snapshot.timeSeconds < 0) throw new RangeError("Invalid film time");
    if (snapshot.timeSeconds < this.lastTime) return;
    const data = filmGeometryData(snapshot.heightM, this.options.lengthM, this.options.widthM);
    for (const [name, values] of [["position", data.positions], ["normal", data.normals], ["color", data.colours]] as const) {
      const existing = this.geometry.getAttribute(name);
      if (existing && existing.array.length === values.length) { existing.array.set(values); existing.needsUpdate = true; }
      else this.geometry.setAttribute(name, new BufferAttribute(values, 3).setUsage(DynamicDrawUsage));
    }
    if (!this.geometry.index || this.geometry.index.count !== data.indices.length) this.geometry.setIndex(new BufferAttribute(data.indices, 1));
    this.geometry.computeBoundingSphere(); this.lastTime = snapshot.timeSeconds; this.dirty = true;
  }
  get needsRender() { return !this.disposed && !this.lost && (this.dirty || !!this.recording?.active); }
  get visualState() { return { timeSeconds: this.lastTime, vertices: this.geometry.getAttribute("position")?.count ?? 0, contextLost: this.lost }; }
  get cameraDistanceM() { return this.controls ? this.camera.position.distanceTo(this.controls.target) / 1000 : 0; }
  render() {
    if (this.disposed || this.lost) return;
    this.gpu.render(this.scene, this.camera);
    const w = this.canvas.width, h = this.canvas.height, margin = h * .025, width = Math.min(w - 2 * margin, h * .65);
    this.overlayCamera.right = w; this.overlayCamera.top = h; this.overlayCamera.updateProjectionMatrix();
    this.label.position.set(margin, h - margin, 0); this.label.scale.set(width, width * .15, 1);
    const clear = this.gpu.autoClear;
    try { this.gpu.autoClear = false; this.gpu.clearDepth(); this.gpu.render(this.overlay, this.overlayCamera); }
    finally { this.gpu.autoClear = clear; }
    this.dirty = false;
  }
  dispose() {
    if (this.disposed) return; this.disposed = true;
    this.detachAbort?.(); this.recording?.dispose(); this.observer?.disconnect(); this.controls?.dispose();
    this.controls?.removeEventListener("change", this.changed);
    this.canvas.removeEventListener("keydown", this.key); this.canvas.removeEventListener("webglcontextlost", this.contextLost);
    this.geometry.dispose(); this.material.dispose(); this.substrateGeometry.dispose(); this.substrateMaterial.dispose();
    this.label.material.dispose(); this.labelTexture.dispose(); this.environment?.dispose(); this.scene.clear(); this.overlay.clear();
    this.gpu.dispose(); this.gpu.forceContextLoss(); this.canvas.remove();
  }
}
