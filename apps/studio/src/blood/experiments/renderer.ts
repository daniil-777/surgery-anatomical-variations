import {
  ACESFilmicToneMapping, BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, Color, DataTexture, DirectionalLight,
  DoubleSide, DynamicDrawUsage, EdgesGeometry, Group, InstancedMesh, LineBasicMaterial, LineSegments, Matrix4, Mesh,
  LinearFilter, LinearMipmapLinearFilter, MeshPhysicalMaterial, MeshStandardMaterial, OrthographicCamera, PCFShadowMap, PerspectiveCamera,
  PlaneGeometry, PMREMGenerator, Quaternion, RepeatWrapping, Scene, SphereGeometry, SpotLight, Sprite, SpriteMaterial, SRGBColorSpace,
  TubeGeometry, Vector3, WebGLRenderer, type Material, type WebGLRenderTarget,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { registerSceneRecordingSource } from "../../sceneRecordingSource";
import { bloodAppearanceTransport } from "./bloodAppearanceOptics";
import { closedTriangleVolumeM3, ligamentGeometryData, validateDroplets, type DropletGeometryInput, type LigamentGeometryInput } from "./breakupGeometry";
import {
  tankBoundaryData, tankSurfaceData, validateTankGeometry, vesselApertures, vesselFrame, vesselWallData,
  type ApertureSpec, type GeometryData, type MetrePoint, type TankGeometryConfig, type VesselGeometryConfig,
} from "./geometry";
import {
  cachedVesselWallMapData, DEFAULT_EXPERIMENT_APPEARANCE, relativeCameraLightPower, resolveAppearance, type ExperimentAppearance,
} from "./appearance";

export interface TankRendererOptions extends TankGeometryConfig { onError?: (message: string) => void }
export interface TankRenderFrame {
  timeSeconds: number;
  heightM: ArrayLike<number>;
  body: null | {
    shape: "sphere" | "cube"; positionM: MetrePoint; radiusM?: number; sizeM?: number;
  };
}
export interface VesselRendererOptions extends VesselGeometryConfig {
  collectionPlaneYM?: number;
  collectionWidthM?: number;
  collectionDepthM?: number;
  /** Physical lower corner of the accepted collector grid. */
  collectionOriginXM?: number;
  collectionOriginZM?: number;
  /** Physical domain to frame initially; trajectories are never rescaled. */
  viewExtentM?: number;
  onError?: (message: string) => void;
}
export interface VesselRenderFrame {
  timeSeconds: number;
  /** Accepted solver emission cadence, used to preserve real occlusion gaps. */
  emissionStepSeconds: number;
  vesselVolumeM3: number;
  landedVolumeM3: number;
  /** Accepted spatial film, including its explicitly accounted initial prewet
   * layer. No renderer-generated spreading or uniform volume-plane fallback. */
  collector: CollectorRenderField;
  breakup: {
    ligaments: readonly LigamentGeometryInput[];
    droplets: readonly DropletGeometryInput[];
  };
  jets: readonly {
    holeId: string; flowM3S: number; velocityMS: number; expelledVolumeM3: number;
    positionM: MetrePoint; direction: MetrePoint; radiusM: number;
  }[];
  parcels: readonly {
    id: number; holeId: string; positionM: MetrePoint; velocityMS: MetrePoint;
    volumeM3: number; ageSeconds: number; emissionTimeSeconds: number;
  }[];
}
export interface CollectorRenderField {
  heightM: ArrayLike<number>;
  nx: number; nz: number;
  widthM: number; depthM: number;
  originXM: number; originZM: number;
}
/** Finite display domain for the solver's closed lateral collector boundary.
 * These are authored tray dimensions, not parameters of a spill simulation. */
export const collectorTrayRimHeightM = (widthM: number, depthM: number) => .1 * Math.min(widthM, depthM);
export const COLLECTOR_TRAY_WALL_THICKNESS_M = .001;

interface Disposable { dispose(): void }
const pointOK = (p: MetrePoint) => p.length === 3 && p.every(Number.isFinite);
const worldPoint = (p: MetrePoint) => new Vector3(...p).multiplyScalar(1000);
const mm = (m: number) => `${(m * 1000).toLocaleString("en", { maximumFractionDigits: 1 })} mm`;
function bloodMaterial(depthM: number, vertexColors = false, oxygenationFraction = .98) {
  const reflectance = bloodAppearanceTransport(depthM, oxygenationFraction).reflectance;
  return new MeshPhysicalMaterial({
    color: vertexColors ? 0xffffff : new Color().setRGB(...reflectance),
    vertexColors, roughness: .16, metalness: 0, ior: 1.35, side: DoubleSide,
  });
}
function writeGeometry(geometry: BufferGeometry, data: GeometryData) {
  for (const [name, values] of [["position", data.positions], ["normal", data.normals], ["color", data.colours]] as const) {
    const attribute = geometry.getAttribute(name);
    if (attribute?.array === values) attribute.needsUpdate = true;
    else geometry.setAttribute(name, new BufferAttribute(values, 3).setUsage(DynamicDrawUsage));
  }
  if (geometry.index?.array !== data.indices) geometry.setIndex(new BufferAttribute(data.indices, 1));
  geometry.computeBoundingSphere();
}

/** Renderer lifecycle shared by the two experiments. No simulation timer or
 * hidden animation: only accepted frames and camera interaction change pixels.
 */
class ExperimentViewport {
  readonly canvas: HTMLCanvasElement;
  protected readonly gpu: WebGLRenderer;
  protected readonly scene = new Scene();
  protected readonly camera = new PerspectiveCamera(35, 1, .01, 10_000);
  protected readonly resources = new Set<Disposable>();
  protected controls?: OrbitControls;
  protected disposed = false;
  protected lost = false;
  protected dirty = true;
  protected timeSeconds = -1;
  protected appearance: ExperimentAppearance = { ...DEFAULT_EXPERIMENT_APPEARANCE };
  private studioKey: DirectionalLight | undefined;
  private cameraLight: SpotLight | undefined;
  private readonly reference = new Group();
  private observer?: ResizeObserver;
  private recording?: ReturnType<typeof registerSceneRecordingSource>;
  private detachAbort: (() => void) | undefined;
  private readonly overlay = new Scene();
  private readonly overlayCamera = new OrthographicCamera(0, 1, 1, 0, 0, 2);
  private readonly labelCanvas: HTMLCanvasElement;
  private readonly labelTexture: CanvasTexture;
  private readonly label: Sprite;
  private readonly home: Vector3;
  private readonly target: Vector3;
  private inspectionView: "overview" | "detail" = "overview";
  private overviewPose: { position: Vector3; target: Vector3; quaternion: Quaternion; zoom: number; fit: number } | undefined;
  private overviewBounds: readonly Vector3[] | undefined;
  private fit = 1;
  private captionKey = "";
  constructor(protected readonly host: HTMLElement, protected readonly errorHandler: ((message: string) => void) | undefined,
    label: string, private readonly extent: number, target: Vector3, homeDirection = new Vector3(.9, .8, 1.15)) {
    this.gpu = new WebGLRenderer({ antialias: true, alpha: false });
    this.canvas = this.gpu.domElement; this.target = target.clone();
    this.home = homeDirection.normalize().multiplyScalar(extent * 2.35).add(target);
    this.labelCanvas = document.createElement("canvas"); this.labelCanvas.width = 1600; this.labelCanvas.height = 190;
    this.labelTexture = this.own(new CanvasTexture(this.labelCanvas)); this.labelTexture.colorSpace = SRGBColorSpace;
    this.label = new Sprite(this.own(new SpriteMaterial({ map: this.labelTexture, depthTest: false, depthWrite: false, toneMapped: false })));
    this.label.center.set(0, 1); this.overlay.add(this.label); this.overlayCamera.position.z = 1;
    try {
      this.canvas.tabIndex = 0;
      this.canvas.setAttribute("aria-label", `${label}. Drag or use arrows to orbit, plus and minus to zoom, Home to reset.`);
      this.canvas.style.cssText = "display:block;width:100%;height:100%;touch-action:none";
      host.appendChild(this.canvas);
      this.gpu.outputColorSpace = SRGBColorSpace; this.gpu.toneMapping = ACESFilmicToneMapping; this.gpu.toneMappingExposure = 1;
      this.gpu.shadowMap.enabled = true; this.gpu.shadowMap.type = PCFShadowMap;
      this.scene.background = new Color("#111922");
      const room = new RoomEnvironment(), generator = new PMREMGenerator(this.gpu);
      try { const environment = this.own<WebGLRenderTarget>(generator.fromScene(room, .04)); this.scene.environment = environment.texture; }
      finally { room.dispose(); generator.dispose(); }
      this.scene.environmentIntensity = .65;
      const light = this.studioKey = new DirectionalLight(0xffffff, 2.2);
      light.position.copy(target).add(new Vector3(-.7, 1.7, .6).multiplyScalar(extent));
      light.target.position.copy(target); light.castShadow = true; light.shadow.mapSize.set(1024, 1024);
      light.shadow.camera.left = -extent; light.shadow.camera.right = extent;
      light.shadow.camera.top = extent; light.shadow.camera.bottom = -extent;
      light.shadow.camera.near = extent * .05; light.shadow.camera.far = extent * 6;
      // PCF samples neighbouring texels, whose stored depths differ on a
      // sloping receiver. Half a texel left visible bands with this light
      // angle; one full world-space texel clears the tested height-field
      // envelope. Only comparison coordinates move, never fluid geometry.
      light.shadow.normalBias = 2 * extent / light.shadow.mapSize.x;
      light.shadow.bias = -1 / 16_777_216;
      this.own(light.shadow); this.scene.add(light, light.target);
      const cameraLight = this.cameraLight = new SpotLight(0xffffff,
        relativeCameraLightPower(extent * 2.35 / 1000), 0, Math.PI / 4, .65, 2);
      // Co-located direct illumination already shares camera visibility; no
      // independent shadow map or ambient term is needed for this mode.
      this.scene.add(cameraLight, cameraLight.target);
      const patchWidth = extent * .075, patchDepth = extent * .075;
      for (const [i, reflectance] of [.18, .8].entries()) {
        const patch = new Mesh(this.own(new BoxGeometry(patchWidth, extent * .003, patchDepth)),
          this.own(new MeshPhysicalMaterial({ color: new Color().setRGB(reflectance, reflectance, reflectance),
            roughness: 1, metalness: 0, specularIntensity: 0, ior: 1 })));
        patch.position.set(-extent * .62 + i * patchWidth * 1.05, extent * .0015, extent * .3); this.reference.add(patch);
      }
      this.reference.visible = false; this.scene.add(this.reference);
      this.camera.position.copy(this.home);
      this.controls = new OrbitControls(this.camera, this.canvas);
      this.controls.target.copy(target); this.controls.minDistance = extent * .22; this.controls.maxDistance = extent * 10;
      this.controls.enableDamping = false; this.controls.update(); this.controls.saveState();
      this.applyLighting();
      this.controls.addEventListener("change", this.changed);
      this.canvas.addEventListener("keydown", this.key); this.canvas.addEventListener("webglcontextlost", this.contextLost);
      this.recording = registerSceneRecordingSource({ renderer: this.gpu, camera: this.camera, host, label,
        draw: () => this.render(), available: () => !this.disposed && !this.lost });
      const prepare = this.recording.source.prepare.bind(this.recording.source);
      this.recording.source.prepare = request => {
        const lease = prepare(request); let restored = false;
        const detach = () => { request.signal.removeEventListener("abort", restore); this.detachAbort = undefined; };
        const restore = () => { if (restored) return; restored = true; detach(); lease.restore(); this.resize(); };
        this.detachAbort = detach; request.signal.addEventListener("abort", restore, { once: true });
        return { restore };
      };
      this.observer = new ResizeObserver(this.resize); this.observer.observe(host); this.resize(); this.resetHome();
    } catch (error) { this.dispose(); throw error; }
  }
  protected own<T extends Disposable>(resource: T): T { this.resources.add(resource); return resource; }
  protected release(resource: Disposable) { if (this.resources.delete(resource)) resource.dispose(); }
  /** Fit the physical scene domain, with the upper 17.5% reserved for the
   * recording caption. Perspective constraints include corner depth, so a
   * near tray edge cannot be clipped by fitting only its projected width. */
  protected fitOverviewToBounds(points: readonly Vector3[]) {
    if (!points.length || points.some(p => !p.toArray().every(Number.isFinite)))
      throw new RangeError("Overview bounds must be finite");
    const lower = new Vector3(Infinity, Infinity, Infinity), upper = new Vector3(-Infinity, -Infinity, -Infinity);
    for (const p of points) { lower.min(p); upper.max(p); }
    const direction = this.home.clone().sub(this.target).normalize();
    this.target.copy(lower).add(upper).multiplyScalar(.5);
    this.overviewBounds = points.map(p => p.clone());
    this.home.copy(direction).add(this.target); // Store the direction before solving distance.
    const distance = this.overviewDistance(1.5);
    this.home.copy(direction).multiplyScalar(distance).add(this.target);
    this.fit = this.overviewDistance(this.camera.aspect) / distance;
    this.resetHome();
  }
  private overviewDistance(aspect: number) {
    const direction = this.home.clone().sub(this.target).normalize();
    const right = new Vector3(0, 1, 0).cross(direction).normalize(), up = direction.clone().cross(right);
    const tanHalfFov = Math.tan(this.camera.fov * Math.PI / 360);
    let distance = this.extent * .25;
    for (const p of this.overviewBounds ?? []) {
      const v = p.clone().sub(this.target), x = v.dot(right), y = v.dot(up), z = v.dot(direction);
      distance = Math.max(distance, z + Math.abs(x) / (.9 * tanHalfFov * aspect),
        z + Math.abs(y) / ((y >= 0 ? .65 : .9) * tanHalfFov));
    }
    return distance * (1 + 1e-12);
  }
  private resetHome() {
    if (!this.controls) return;
    this.inspectionView = "overview"; this.overviewPose = undefined; this.camera.zoom = 1;
    this.controls.target.copy(this.target);
    const position = this.home.clone().sub(this.target).multiplyScalar(this.fit).add(this.target);
    this.controls.maxDistance = Math.max(this.extent * 10, position.distanceTo(this.target) * 2);
    this.camera.position.copy(position); this.controls.update();
    // Keep Home and initial framing identical after OrbitControls' spherical
    // bookkeeping, including the finite precision of the saved quaternion.
    this.camera.position.copy(position); this.camera.lookAt(this.target); this.clipping(); this.dirty = true;
  }
  /** The two matte targets share actual scene illumination and exposure. */
  protected placeReference(position: Vector3) {
    this.reference.position.copy(position);
    if (position.y > 0) {
      const support = new Mesh(this.own(new BoxGeometry(this.extent * .17, position.y, this.extent * .09)),
        this.own(new MeshStandardMaterial({ color: new Color().setRGB(.06, .06, .06), roughness: .8 })));
      support.position.set(-this.extent * .62 + this.extent * .075 * .525, -position.y / 2, this.extent * .3);
      this.reference.add(support);
    }
    this.dirty = true;
  }
  protected inspectionTarget() { return this.target.clone(); }
  protected inspectionZoom() { return 3; }
  setInspectionView(mode: "overview" | "detail") {
    if (mode !== "overview" && mode !== "detail") throw new RangeError("Unknown inspection view");
    if (this.disposed || this.lost || !this.controls || mode === this.inspectionView) return;
    const fixedPosition = this.camera.position.clone();
    let restoredQuaternion: Quaternion | undefined;
    if (mode === "detail") {
      this.overviewPose = { position: this.camera.position.clone(), target: this.controls.target.clone(),
        quaternion: this.camera.quaternion.clone(), zoom: this.camera.zoom, fit: this.fit };
      // Lens magnification does not move the camera-coincident light closer
      // to the sample or alter its power. No geometry or accepted state moves.
      this.controls.target.copy(this.inspectionTarget()); this.camera.zoom = this.inspectionZoom();
    } else if (this.overviewPose) {
      const pose = this.overviewPose;
      this.controls.target.copy(pose.target);
      this.camera.position.copy(pose.position);
      if (this.fit !== pose.fit) this.camera.position.sub(pose.target).multiplyScalar(this.fit / pose.fit).add(pose.target);
      fixedPosition.copy(this.camera.position); restoredQuaternion = pose.quaternion;
      this.camera.zoom = pose.zoom; this.overviewPose = undefined;
    }
    this.inspectionView = mode; this.controls.update();
    // OrbitControls' spherical round-trip can perturb a stationary position
    // by a few ulps. Preserve the exact inspection origin, not just its scale.
    this.camera.position.copy(fixedPosition);
    if (restoredQuaternion) this.camera.quaternion.copy(restoredQuaternion);
    else this.camera.lookAt(this.controls.target);
    this.clipping();
    this.dirty = true;
  }
  setAppearance(change: Partial<ExperimentAppearance>) {
    if (this.disposed || this.lost) return;
    const next = resolveAppearance(this.appearance, change);
    const previous = this.appearance;
    this.appearance = next; this.applyLighting(); this.appearanceChanged(previous); this.dirty = true;
  }
  protected appearanceChanged(_previous?: ExperimentAppearance) { /* Geometry-specific materials override this. */ }
  private applyLighting() {
    const cameraMode = this.appearance.illumination === "camera";
    this.gpu.toneMappingExposure = 2 ** this.appearance.exposureEV;
    if (this.studioKey) this.studioKey.visible = !cameraMode;
    if (this.cameraLight) this.cameraLight.visible = cameraMode;
    this.scene.environmentIntensity = cameraMode ? 0 : .45;
    this.reference.visible = this.appearance.referencePatch;
  }
  protected caption(title: string, subtitle: string) {
    const key = `${title}\n${subtitle}`; if (key === this.captionKey) return;
    this.captionKey = key;
    const ctx = this.labelCanvas.getContext("2d"); if (!ctx) return;
    ctx.clearRect(0, 0, 1600, 190); ctx.fillStyle = "rgba(10,17,24,.88)"; ctx.fillRect(0, 0, 1600, 190);
    ctx.fillStyle = "#f3f5f7"; ctx.font = "500 47px sans-serif"; ctx.fillText(title, 32, 68, 1536);
    ctx.fillStyle = "#c1ccd5"; ctx.font = "34px sans-serif"; ctx.fillText(subtitle, 32, 131, 1536);
    this.labelTexture.needsUpdate = true; this.dirty = true;
  }
  protected frameTime(t: number) {
    if (!Number.isFinite(t) || t < 0) throw new RangeError("Experiment time must be finite and non-negative");
    return !this.disposed && !this.lost && t >= this.timeSeconds;
  }
  private clipping() {
    const distance = this.camera.position.distanceTo(this.controls?.target ?? this.target);
    // A near plane thousands of times smaller than the actual camera distance
    // quantised micrometre receiver films into the tray. Maintain a bounded
    // depth range as the user orbits/zooms, without moving either surface.
    this.camera.near = Math.max(.01, distance * .025);
    this.camera.far = distance + this.extent * 12;
    this.camera.updateProjectionMatrix();
  }
  private readonly changed = () => { this.clipping(); this.dirty = true; };
  private readonly resize = () => {
    if (this.disposed || this.lost || this.recording?.active) return;
    const w = Math.max(16, this.host.clientWidth), h = Math.max(16, this.host.clientHeight);
    const fit = this.overviewBounds ? this.overviewDistance(w / h) / this.home.distanceTo(this.target)
      : Math.max(1, 1.5 / (w / h));
    this.gpu.setPixelRatio(Math.min(Math.max(1, globalThis.devicePixelRatio || 1), 2)); this.gpu.setSize(w, h);
    this.camera.aspect = w / h;
    if (fit !== this.fit)
      this.camera.position.sub(this.controls!.target).multiplyScalar(fit / this.fit).add(this.controls!.target);
    this.fit = fit;
    this.controls!.maxDistance = Math.max(this.extent * 10, this.home.distanceTo(this.target) * fit * 2);
    this.clipping(); this.dirty = true;
  };
  private readonly key = (event: KeyboardEvent) => {
    if (!this.controls || this.lost || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "=", "-", "Home"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Home") {
      this.resetHome(); return;
    }
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
    this.detachAbort?.(); this.errorHandler?.("Experiment graphics context lost. Reset the experiment to recover.");
  };
  get needsRender() { return !this.disposed && !this.lost && (this.dirty || !!this.recording?.active); }
  get visualState() { return { timeSeconds: this.timeSeconds, contextLost: this.lost,
    cameraPosition: this.camera.position.toArray(), cameraTarget: this.controls?.target.toArray() ?? [],
    cameraQuaternion: this.camera.quaternion.toArray(),
    cameraProjection: { verticalFieldOfViewDegrees: this.camera.fov, aspect: this.camera.aspect,
      nearM: this.camera.near / 1000, farM: this.camera.far / 1000 },
    cameraZoom: this.camera.zoom, inspectionView: this.inspectionView,
    recording: this.recording?.active ?? false, appearance: { ...this.appearance } }; }
  render() {
    if (this.disposed || this.lost) return;
    if (this.cameraLight) { this.cameraLight.position.copy(this.camera.position); this.cameraLight.target.position.copy(this.controls?.target ?? this.target); }
    this.gpu.render(this.scene, this.camera);
    const w = this.canvas.width, h = this.canvas.height, margin = h * .025, width = Math.min(w - 2 * margin, h * 1.05);
    this.overlayCamera.right = w; this.overlayCamera.top = h; this.overlayCamera.updateProjectionMatrix();
    this.label.position.set(margin, h - margin, 0); this.label.scale.set(width, width * 190 / 1600, 1);
    const clear = this.gpu.autoClear;
    try { this.gpu.autoClear = false; this.gpu.clearDepth(); this.gpu.render(this.overlay, this.overlayCamera); }
    finally { this.gpu.autoClear = clear; }
    this.dirty = false;
  }
  dispose() {
    if (this.disposed) return; this.disposed = true;
    this.detachAbort?.(); this.recording?.dispose(); this.observer?.disconnect();
    this.controls?.removeEventListener("change", this.changed); this.controls?.dispose();
    this.canvas.removeEventListener("keydown", this.key); this.canvas.removeEventListener("webglcontextlost", this.contextLost);
    for (const resource of this.resources) resource.dispose(); this.resources.clear();
    this.scene.clear(); this.overlay.clear(); this.gpu.dispose(); this.gpu.forceContextLoss(); this.canvas.remove();
  }
}

export class TankRenderer extends ExperimentViewport {
  private readonly surface: BufferGeometry;
  private readonly boundary: BufferGeometry;
  private surfaceData?: GeometryData;
  private boundaryData?: GeometryData;
  private readonly sphere: Mesh;
  private readonly cube: Mesh;
  private bodyPosition: MetrePoint | null = null;
  private heightRange: [number, number] = [0, 0];
  private acceptedHeightM: Float64Array | undefined;
  constructor(host: HTMLElement, private readonly options: TankRendererOptions) {
    validateTankGeometry(options);
    const extent = Math.max(options.widthM, options.depthM, options.heightM) * 1000;
    super(host, options.onError, "Blood tank experiment", extent, new Vector3(0, options.heightM * 1000 * .27, 0));
    this.surface = this.own(new BufferGeometry()); this.boundary = this.own(new BufferGeometry());
    const bodyMaterial = this.own(new MeshStandardMaterial({ color: 0xb2bdc5, metalness: .82, roughness: .23 }));
    this.sphere = new Mesh(this.own(new SphereGeometry(1, 48, 32)), bodyMaterial);
    this.cube = new Mesh(this.own(new BoxGeometry(1, 1, 1)), bodyMaterial);
    try {
      // Put the matte targets beside the front edge, outside the fluid/glass
      // footprint, with their top faces at the sample's initial fill height.
      // This support is presentation geometry, never solver fluid volume.
      const referenceY = options.heightM * 1000 * .08;
      this.placeReference(new Vector3(extent * .8, referenceY - extent * .003, options.depthM * 500 - extent * .17));
      const fluidMaterial = this.own(bloodMaterial(options.heightM, true));
      const top = new Mesh(this.surface, fluidMaterial), sides = new Mesh(this.boundary, fluidMaterial);
      top.castShadow = top.receiveShadow = true; sides.castShadow = true; this.scene.add(top, sides);
      const floor = new Mesh(this.own(new BoxGeometry(options.widthM * 1000, 1, options.depthM * 1000)),
        this.own(new MeshStandardMaterial({ color: new Color().setRGB(.28, .28, .28), roughness: .7 })));
      floor.position.y = -.5; floor.receiveShadow = true; this.scene.add(floor);
      const enclosure = this.own(new BoxGeometry(options.widthM * 1000, options.heightM * 1000, options.depthM * 1000));
      const frame = new LineSegments(this.own(new EdgesGeometry(enclosure)), this.own(new LineBasicMaterial({ color: 0x7f9aa9, transparent: true, opacity: .7 })));
      frame.position.y = options.heightM * 500; this.scene.add(frame);
      // Render the outside faces of a 1 mm enclosure. A pane placed exactly
      // on the fluid boundary produced coplanar depth-test facets; the outside
      // face is physically separate while the solver's inner wall stays put.
      const enclosureThicknessMM = 1;
      const wallMaterial = this.own(new MeshPhysicalMaterial({ color: 0xb9d1df, transparent: true, opacity: .065,
        depthWrite: false, roughness: .15, metalness: 0, side: DoubleSide }));
      for (const axis of ["x", "z"] as const) for (const sign of [-1, 1]) {
        const wall = new Mesh(this.own(new PlaneGeometry((axis === "x" ? options.depthM : options.widthM) * 1000, options.heightM * 1000)), wallMaterial);
        wall.position.y = options.heightM * 500;
        if (axis === "x") { wall.position.x = sign * (options.widthM * 500 + enclosureThicknessMM); wall.rotation.y = Math.PI / 2; }
        else wall.position.z = sign * (options.depthM * 500 + enclosureThicknessMM);
        this.scene.add(wall);
      }
      this.sphere.visible = this.cube.visible = false; this.sphere.castShadow = this.cube.castShadow = true;
      this.scene.add(this.sphere, this.cube);
      this.caption(`BLOOD TANK · ${mm(options.widthM)} × ${mm(options.depthM)}`,
        "Hydrostatic height field · true surface scale · no spray model");
    } catch (error) { this.dispose(); throw error; }
  }
  update(frame: TankRenderFrame) {
    if (!this.frameTime(frame.timeSeconds)) return;
    if (frame.body && (!pointOK(frame.body.positionM) || !["sphere", "cube"].includes(frame.body.shape) ||
      !Number.isFinite(frame.body.shape === "sphere" ? frame.body.radiusM : frame.body.sizeM) ||
      (frame.body.shape === "sphere" ? frame.body.radiusM! : frame.body.sizeM!) <= 0))
      throw new RangeError("Invalid accepted tank body");
    const data = tankSurfaceData(this.options, frame.heightM, this.surfaceData, this.appearance.oxygenationFraction);
    this.surfaceData = data; this.boundaryData = tankBoundaryData(this.options, data, this.boundaryData, this.appearance.oxygenationFraction);
    if (!this.acceptedHeightM || this.acceptedHeightM.length !== frame.heightM.length) this.acceptedHeightM = Float64Array.from(frame.heightM);
    else this.acceptedHeightM.set(frame.heightM);
    writeGeometry(this.surface, data); writeGeometry(this.boundary, this.boundaryData);
    this.sphere.visible = !!frame.body && frame.body.shape === "sphere";
    this.cube.visible = !!frame.body && frame.body.shape === "cube";
    if (frame.body) {
      const mesh = frame.body.shape === "sphere" ? this.sphere : this.cube;
      mesh.position.copy(worldPoint(frame.body.positionM)).sub(new Vector3(this.options.widthM * 500, 0, this.options.depthM * 500));
      mesh.scale.setScalar((frame.body.shape === "sphere" ? frame.body.radiusM! : frame.body.sizeM!) * 1000);
      this.bodyPosition = [...frame.body.positionM];
    } else this.bodyPosition = null;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < frame.heightM.length; i++) { lo = Math.min(lo, frame.heightM[i]!); hi = Math.max(hi, frame.heightM[i]!); }
    this.heightRange = [lo, hi]; this.timeSeconds = frame.timeSeconds; this.dirty = true;
  }
  protected override appearanceChanged(previous?: ExperimentAppearance) {
    if (!this.acceptedHeightM || previous?.oxygenationFraction === this.appearance.oxygenationFraction) return;
    this.surfaceData = tankSurfaceData(this.options, this.acceptedHeightM, this.surfaceData, this.appearance.oxygenationFraction);
    this.boundaryData = tankBoundaryData(this.options, this.surfaceData, this.boundaryData, this.appearance.oxygenationFraction);
    this.surface.getAttribute("color").needsUpdate = true; this.boundary.getAttribute("color").needsUpdate = true;
  }
  protected override inspectionTarget() {
    return this.bodyPosition
      ? worldPoint(this.bodyPosition).sub(new Vector3(this.options.widthM * 500, 0, this.options.depthM * 500))
      : new Vector3(0, (this.heightRange[0] + this.heightRange[1]) * 500, 0);
  }
  override get visualState() { return { ...super.visualState, vertices: this.surface.getAttribute("position")?.count ?? 0,
    bodyPositionM: this.bodyPosition ? [...this.bodyPosition] : null, heightRangeM: [...this.heightRange] }; }
}

export class VesselRenderer extends ExperimentViewport {
  private readonly vesselGroup = new Group();
  private wallGeometry: BufferGeometry | undefined;
  private wallMesh: Mesh | undefined;
  private readonly wallMaterials: Material[];
  private readonly jetGeometry: BufferGeometry;
  private readonly dropletGeometry: SphereGeometry;
  private readonly dropletMaterial: MeshPhysicalMaterial;
  private droplets: InstancedMesh | undefined;
  private dropletCapacity = 0;
  private dropletCount = 0;
  private dropletVolumeM3 = 0;
  private ligamentCount = 0;
  private readonly dropletRadiusCorrection: number;
  private acceptedDroplets: readonly DropletGeometryInput[] = [];
  private readonly collector: Mesh;
  private geometryOptions: VesselGeometryConfig;
  private readonly collectionAreaM2: number;
  private readonly collectionYM: number;
  private readonly collectionCenterM: Vector3;
  private readonly collectionWidthM: number;
  private readonly collectionDepthM: number;
  private readonly collectionRimHeightM: number;
  private parcelCount = 0;
  private jetVolumeM3 = 0;
  private apertureCount = 0;
  private lastVesselVolumeM3 = 0;
  private readonly wallMaps: { colour: DataTexture; normal: DataTexture; roughness: DataTexture }[] = [];
  private readonly liquidMaterials: { material: MeshPhysicalMaterial; thicknessM: number }[] = [];
  private jetThicknessM = new Float32Array();
  private collectorData: GeometryData | undefined;
  private collectorField: (Omit<CollectorRenderField, "heightM"> & { heightM: Float64Array }) | undefined;
  private collectorHeightRangeM: [number, number] = [0, 0];
  private collectorFilmVolumeM3 = 0;
  constructor(host: HTMLElement, options: VesselRendererOptions) {
    const frame = vesselFrame(options); vesselApertures(options);
    if (options.viewExtentM !== undefined && (!Number.isFinite(options.viewExtentM) || options.viewExtentM <= 0 || options.viewExtentM > 2))
      throw new RangeError("Invalid vessel view extent");
    const center = frame.curve.getPointAt(.5).multiplyScalar(1000), extent = (options.viewExtentM ?? frame.lengthM) * 1000;
    // A moderately elevated overview sees a representative impact 20 mm
    // inside the forward rim without hiding or thinning the physical walls.
    super(host, options.onError, "Vessel flow experiment", extent, center, new Vector3(.35, 1.35, 1.6));
    this.geometryOptions = { ...options, holes: options.holes.map(h => ({ ...h })) };
    this.collectionYM = options.collectionPlaneYM ?? 0;
    const width = options.collectionWidthM ?? frame.lengthM * 2.4, depth = options.collectionDepthM ?? frame.lengthM * 2.4;
    this.collectionAreaM2 = width * depth;
    this.collectionWidthM = width; this.collectionDepthM = depth;
    this.collectionRimHeightM = collectorTrayRimHeightM(width, depth);
    this.collectionCenterM = new Vector3(
      options.collectionOriginXM === undefined ? center.x * .001 : options.collectionOriginXM + width / 2,
      this.collectionYM,
      options.collectionOriginZM === undefined ? center.z * .001 : options.collectionOriginZM + depth / 2);
    this.wallMaterials = [
      this.own(new MeshPhysicalMaterial({ color: 0xffffff, roughness: 1, ior: 1.35, side: DoubleSide })),
      this.own(new MeshPhysicalMaterial({ color: 0xffffff, roughness: 1, ior: 1.35, side: DoubleSide })),
      this.own(new MeshPhysicalMaterial({ color: 0xffffff, vertexColors: true, roughness: .32, ior: 1.35, side: DoubleSide })),
    ];
    this.jetGeometry = this.own(new BufferGeometry());
    this.dropletGeometry = this.own(new SphereGeometry(1, 32, 24));
    const unitSphereVolumeMM3 = Math.abs(closedTriangleVolumeM3(this.dropletGeometry.attributes.position!.array,
      this.dropletGeometry.index!.array)) * 1e9;
    this.dropletRadiusCorrection = Math.cbrt((4 * Math.PI / 3) / unitSphereVolumeMM3);
    this.dropletMaterial = this.own(bloodMaterial(.001, true));
    this.collector = new Mesh(this.own(new BufferGeometry()), this.own(bloodMaterial(.001, true)));
    try {
      if (![width, depth].every(v => Number.isFinite(v) && v > 0 && v <= 2)
        || !this.collectionCenterM.toArray().every(Number.isFinite))
        throw new RangeError("Invalid vessel collection plane");
      for (const [layer, radius] of [["adventitia", options.innerRadiusM + options.wallThicknessM], ["intima", options.innerRadiusM]] as const) {
        const repetitions = Math.max(1, Math.round(2 * Math.PI * radius / .004));
        const maps = cachedVesselWallMapData({ layer, circumferentialPeriodM: 2 * Math.PI * radius / repetitions });
        const texture = (bytes: Uint8Array, colour: boolean) => {
          const map = this.own(new DataTexture(bytes, maps.size, maps.size));
          if (colour) map.colorSpace = SRGBColorSpace;
          map.wrapS = map.wrapT = RepeatWrapping; map.magFilter = LinearFilter; map.minFilter = LinearMipmapLinearFilter;
          map.generateMipmaps = true; map.anisotropy = Math.min(8, this.gpu.capabilities.getMaxAnisotropy());
          map.repeat.set(1 / maps.metadata.axialPeriodM, repetitions); map.needsUpdate = true; return map;
        };
        this.wallMaps.push({ colour: texture(maps.colour, true), normal: texture(maps.normal, false), roughness: texture(maps.roughness, false) });
      }
      this.scene.add(this.vesselGroup);
      const liquid = (thicknessM: number) => {
        const material = this.own(bloodMaterial(thicknessM)); this.liquidMaterials.push({ material, thicknessM }); return material;
      };
      const lumen = new Mesh(this.own(new TubeGeometry(frame.curve, 128, options.innerRadiusM * .997, 48, false)),
        liquid(options.innerRadiusM * 2));
      lumen.scale.setScalar(1000); this.vesselGroup.add(lumen);
      // Blood at open ends is a true disk in the lumen, not a cap on the wall.
      for (const u of [0, 1]) {
        const end = frame.curve.getPointAt(u), tangent = frame.curve.getTangentAt(u);
        const cap = new Mesh(this.own(new SphereGeometry(options.innerRadiusM * 1000 * .997, 48, 16)),
          liquid(options.innerRadiusM * 2));
        cap.scale.set(1, 1, .012); cap.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), tangent);
        cap.position.copy(end).multiplyScalar(1000); this.vesselGroup.add(cap);
      }
      this.setHoles(options.holes);
      const jet = new Mesh(this.jetGeometry, this.own(bloodMaterial(.001, true)));
      jet.castShadow = true; this.scene.add(jet);
      const wallThickness = COLLECTOR_TRAY_WALL_THICKNESS_M * 1000, rimHeight = this.collectionRimHeightM * 1000;
      const trayMaterial = this.own(new MeshStandardMaterial({ color: new Color().setRGB(.24, .27, .29), roughness: .65 }));
      const tray = new Mesh(this.own(new BoxGeometry(width * 1000 + 2 * wallThickness, .5, depth * 1000 + 2 * wallThickness)), trayMaterial);
      tray.position.set(this.collectionCenterM.x * 1000, this.collectionYM * 1000 - .26, this.collectionCenterM.z * 1000);
      tray.receiveShadow = true; this.scene.add(tray);
      // All wall thickness is outside the accepted fluid rectangle. Opaque,
      // neutral walls avoid transparent-pane sorting and coplanar fluid faces.
      // Their bases meet the existing tray top. Their height matches the
      // collector's supported shallow-layer bound (16 mm for the default
      // domain). No fluid heights or boundary fluxes move.
      const rimGeometryX = this.own(new BoxGeometry(wallThickness, rimHeight + .01, depth * 1000 + 2 * wallThickness));
      const rimGeometryZ = this.own(new BoxGeometry(width * 1000, rimHeight + .01, wallThickness));
      for (const sign of [-1, 1]) {
        const xWall = new Mesh(rimGeometryX, trayMaterial), zWall = new Mesh(rimGeometryZ, trayMaterial);
        xWall.position.set(this.collectionCenterM.x * 1000 + sign * (width * 1000 + wallThickness) / 2,
          this.collectionYM * 1000 + (rimHeight - .01) / 2, this.collectionCenterM.z * 1000);
        zWall.position.set(this.collectionCenterM.x * 1000,
          this.collectionYM * 1000 + (rimHeight - .01) / 2,
          this.collectionCenterM.z * 1000 + sign * (depth * 1000 + wallThickness) / 2);
        xWall.castShadow = xWall.receiveShadow = zWall.castShadow = zWall.receiveShadow = true;
        this.scene.add(xWall, zWall);
      }
      this.collector.position.copy(this.collectionCenterM).multiplyScalar(1000); this.collector.visible = false; this.scene.add(this.collector);
      this.caption("VESSEL FLOW · OPEN APERTURES + LOCAL IMPACTS", `Reduced breakup · closed ${mm(this.collectionRimHeightM)} tray · rigid vessel wall`);
      this.wallGeometry!.computeBoundingBox();
      const bounds = this.wallGeometry!.boundingBox!;
      const lower = bounds.min.clone().min(new Vector3((this.collectionCenterM.x - width / 2) * 1000 - wallThickness,
        this.collectionYM * 1000 - .51, (this.collectionCenterM.z - depth / 2) * 1000 - wallThickness));
      const upper = bounds.max.clone().max(new Vector3((this.collectionCenterM.x + width / 2) * 1000 + wallThickness,
        this.collectionYM * 1000 + rimHeight, (this.collectionCenterM.z + depth / 2) * 1000 + wallThickness));
      const corners: Vector3[] = [];
      for (const x of [lower.x, upper.x]) for (const y of [lower.y, upper.y]) for (const z of [lower.z, upper.z])
        corners.push(new Vector3(x, y, z));
      this.fitOverviewToBounds(corners);
      this.appearanceChanged();
    } catch (error) { this.dispose(); throw error; }
  }
  setHoles(holes: readonly ApertureSpec[]) {
    if (this.disposed || this.lost) return;
    const next = { ...this.geometryOptions, holes: holes.map(h => ({ ...h })) }, data = vesselWallData(next);
    const geometry = this.own(new BufferGeometry());
    geometry.setAttribute("position", new BufferAttribute(data.positions, 3)); geometry.setAttribute("normal", new BufferAttribute(data.normals, 3));
    geometry.setAttribute("uv", new BufferAttribute(data.uvs, 2)); geometry.setAttribute("color", new BufferAttribute(data.colours, 3));
    geometry.setIndex(new BufferAttribute(data.indices, 1));
    for (const g of data.groups) geometry.addGroup(g.start, g.count, g.materialIndex);
    geometry.computeBoundingSphere();
    if (!this.wallMesh) {
      this.wallMesh = new Mesh(geometry, this.wallMaterials); this.wallMesh.castShadow = this.wallMesh.receiveShadow = true;
      this.vesselGroup.add(this.wallMesh);
    } else this.wallMesh.geometry = geometry;
    if (this.wallGeometry) this.release(this.wallGeometry);
    this.wallGeometry = geometry; this.geometryOptions = next; this.apertureCount = holes.length; this.dirty = true;
  }
  protected override inspectionTarget() {
    const aperture = vesselApertures(this.geometryOptions)[0];
    return aperture ? worldPoint(aperture.positionM) : vesselFrame(this.geometryOptions).curve.getPointAt(.5).multiplyScalar(1000);
  }
  protected override inspectionZoom() { return 6; }
  protected override appearanceChanged(previous?: ExperimentAppearance) {
    if (!previous || previous.wallDetail !== this.appearance.wallDetail) for (let i = 0; i < this.wallMaps.length; i++) {
      const maps = this.wallMaps[i]!, material = this.wallMaterials[i] as MeshPhysicalMaterial;
      material.map = this.appearance.wallDetail ? maps.colour : null;
      material.normalMap = this.appearance.wallDetail ? maps.normal : null;
      material.roughnessMap = this.appearance.wallDetail ? maps.roughness : null;
      material.roughness = this.appearance.wallDetail ? 1 : i ? .21 : .38;
      if (this.appearance.wallDetail) material.color.setRGB(1, 1, 1);
      else if (i) material.color.setRGB(.29, .095, .078);
      else material.color.setRGB(.39, .235, .185);
      material.needsUpdate = true;
    }
    if (!previous || previous.oxygenationFraction !== this.appearance.oxygenationFraction) {
      for (const { material, thicknessM } of this.liquidMaterials)
        material.color.setRGB(...bloodAppearanceTransport(thicknessM, this.appearance.oxygenationFraction).reflectance);
      this.colourJet();
      this.colourDroplets();
      if (this.collectorField) {
        const c = this.collectorField;
        this.collectorData = tankSurfaceData({ ...c, heightM: 2 }, c.heightM, this.collectorData,
          this.appearance.oxygenationFraction, [.24, .27, .29], true);
        this.collector.geometry.getAttribute("color").needsUpdate = true;
      }
    }
  }
  private colourJet() {
    const old = this.jetGeometry.getAttribute("color");
    const colours = old?.count === this.jetThicknessM.length ? old.array as Float32Array : new Float32Array(this.jetThicknessM.length * 3);
    let previousThickness = NaN, previousColour: readonly number[] = [];
    for (let i = 0; i < this.jetThicknessM.length; i++) {
      const thickness = this.jetThicknessM[i]!;
      if (thickness !== previousThickness) {
        previousThickness = thickness; previousColour = bloodAppearanceTransport(thickness, this.appearance.oxygenationFraction).reflectance;
      }
      colours.set(previousColour, i * 3);
    }
    if (old?.array === colours) old.needsUpdate = true;
    else this.jetGeometry.setAttribute("color", new BufferAttribute(colours, 3).setUsage(DynamicDrawUsage));
  }
  private colourDroplets() {
    if (!this.droplets) return;
    const colour = new Color();
    for (let i = 0; i < this.acceptedDroplets.length; i++) {
      colour.setRGB(...bloodAppearanceTransport(this.acceptedDroplets[i]!.radiusM * 2, this.appearance.oxygenationFraction).reflectance);
      this.droplets.setColorAt(i, colour);
    }
    if (this.droplets.instanceColor) this.droplets.instanceColor.needsUpdate = true;
  }
  private writeDroplets(drops: readonly DropletGeometryInput[]) {
    if (drops.length > this.dropletCapacity) {
      this.dropletCapacity = Math.min(8192, 2 ** Math.ceil(Math.log2(Math.max(16, drops.length))));
      if (this.droplets) { this.scene.remove(this.droplets); this.release(this.droplets); }
      this.droplets = this.own(new InstancedMesh(this.dropletGeometry, this.dropletMaterial, this.dropletCapacity));
      this.droplets.instanceMatrix.setUsage(DynamicDrawUsage); this.droplets.castShadow = true; this.scene.add(this.droplets);
    }
    if (!this.droplets) return;
    const matrix = new Matrix4();
    for (let i = 0; i < drops.length; i++) {
      const p = drops[i]!, r = p.radiusM * this.dropletRadiusCorrection * 1000;
      matrix.makeScale(r, r, r).setPosition(p.positionM[0] * 1000, p.positionM[1] * 1000, p.positionM[2] * 1000);
      this.droplets.setMatrixAt(i, matrix);
    }
    this.droplets.count = drops.length; this.droplets.visible = drops.length > 0;
    this.droplets.instanceMatrix.needsUpdate = true; this.droplets.computeBoundingSphere();
    this.colourDroplets();
  }
  update(frame: VesselRenderFrame) {
    if (!this.frameTime(frame.timeSeconds)) return;
    if (![frame.vesselVolumeM3, frame.landedVolumeM3].every(v => Number.isFinite(v) && v >= 0) ||
        !Number.isFinite(frame.emissionStepSeconds) || frame.emissionStepSeconds <= 0 ||
        frame.parcels.length > 100_000 || frame.jets.length > 8) throw new RangeError("Invalid vessel fluid inventory");
    for (const p of frame.parcels) if (!pointOK(p.positionM) || !pointOK(p.velocityMS) ||
      ![p.volumeM3, p.ageSeconds, p.emissionTimeSeconds].every(Number.isFinite) || p.volumeM3 <= 0 || p.ageSeconds < 0)
      throw new RangeError("Invalid vessel parcel");
    for (const j of frame.jets) if (!pointOK(j.positionM) || !pointOK(j.direction) ||
      ![j.flowM3S, j.velocityMS, j.radiusM, j.expelledVolumeM3].every(Number.isFinite) ||
      j.flowM3S < 0 || j.velocityMS < 0 || j.radiusM <= 0 || j.expelledVolumeM3 < 0)
      throw new RangeError("Invalid vessel outlet");
    const field = frame.collector;
    if (!field || ![field.widthM, field.depthM, field.originXM, field.originZM].every(Number.isFinite) ||
      Math.abs(field.widthM - this.collectionWidthM) > 1e-12 || Math.abs(field.depthM - this.collectionDepthM) > 1e-12 ||
      Math.abs(field.originXM + field.widthM / 2 - this.collectionCenterM.x) > 1e-9 ||
      Math.abs(field.originZM + field.depthM / 2 - this.collectionCenterM.z) > 1e-9)
      throw new RangeError("Collector field must match the physical receiver domain");
    validateTankGeometry({ ...field, heightM: 2 });
    if (field.heightM.length !== field.nx * field.nz) throw new RangeError("Invalid collector grid size");
    let lo = Infinity, hi = -Infinity, total = 0;
    for (let i = 0; i < field.heightM.length; i++) {
      const h = field.heightM[i]!;
      if (!Number.isFinite(h) || h < 0 || h > 2) throw new RangeError("Collector heights must be finite and non-negative");
      if (h > this.collectionRimHeightM)
        throw new RangeError(`Collector exceeds its ${mm(this.collectionRimHeightM)} shallow-layer/tray limit; overflow is outside this model`);
      lo = Math.min(lo, h); hi = Math.max(hi, h); total += h;
    }
    if (!frame.breakup || !Array.isArray(frame.breakup.ligaments) || !Array.isArray(frame.breakup.droplets))
      throw new RangeError("Authoritative accepted breakup geometry is required");
    validateDroplets(frame.breakup.droplets);
    const data = ligamentGeometryData(frame.breakup.ligaments);
    this.collectorData = tankSurfaceData({ ...field, heightM: 2 }, field.heightM, this.collectorData,
      this.appearance.oxygenationFraction, [.24, .27, .29], true);
    if (!this.collectorField || this.collectorField.heightM.length !== field.heightM.length)
      this.collectorField = { ...field, heightM: Float64Array.from(field.heightM) };
    else { this.collectorField = { ...field, heightM: this.collectorField.heightM }; this.collectorField.heightM.set(field.heightM); }
    writeGeometry(this.collector.geometry, this.collectorData);
    this.jetThicknessM = data.thicknessM;
    for (const [name, values] of [["position", data.positions], ["normal", data.normals]] as const) {
      const old = this.jetGeometry.getAttribute(name);
      if (old && old.array.length === values.length) { old.array.set(values); old.needsUpdate = true; }
      else this.jetGeometry.setAttribute(name, new BufferAttribute(values, 3).setUsage(DynamicDrawUsage));
    }
    if (!this.jetGeometry.index || this.jetGeometry.index.array.length !== data.indices.length)
      this.jetGeometry.setIndex(new BufferAttribute(data.indices, 1));
    else { this.jetGeometry.index.array.set(data.indices); this.jetGeometry.index.needsUpdate = true; }
    this.jetGeometry.computeBoundingSphere();
    this.colourJet();
    this.acceptedDroplets = frame.breakup.droplets.map(drop => ({ ...drop,
      positionM: [drop.positionM[0], drop.positionM[1], drop.positionM[2]] as MetrePoint }));
    this.writeDroplets(this.acceptedDroplets);
    this.collector.visible = hi > 0;
    this.collector.position.y = this.collectionYM * 1000;
    this.collectorHeightRangeM = [lo, hi];
    this.collectorFilmVolumeM3 = total * this.collectionAreaM2 / (field.nx * field.nz);
    this.parcelCount = frame.parcels.length; this.jetVolumeM3 = data.volumeM3;
    this.dropletCount = this.acceptedDroplets.length; this.ligamentCount = frame.breakup.ligaments.length;
    this.dropletVolumeM3 = this.acceptedDroplets.reduce((sum, drop) => sum + drop.volumeM3, 0);
    this.lastVesselVolumeM3 = frame.vesselVolumeM3; this.timeSeconds = frame.timeSeconds; this.dirty = true;
  }
  override get visualState() { return { ...super.visualState, apertureCount: this.apertureCount, parcelCount: this.parcelCount,
    reconstructedJetVolumeM3: this.jetVolumeM3, vesselVolumeM3: this.lastVesselVolumeM3,
    dropletCount: this.dropletCount, ligamentCount: this.ligamentCount, reconstructedDropletVolumeM3: this.dropletVolumeM3,
    collectorHeightRangeM: [...this.collectorHeightRangeM], collectorFilmVolumeM3: this.collectorFilmVolumeM3,
    collectorGrid: this.collectorField ? [this.collectorField.nx, this.collectorField.nz] : null,
    collectorRimHeightM: this.collectionRimHeightM, collectorWallThicknessM: COLLECTOR_TRAY_WALL_THICKNESS_M,
    collectorOriginM: [this.collectionCenterM.x - this.collectionWidthM / 2, this.collectionCenterM.z - this.collectionDepthM / 2],
    wallVertices: this.wallGeometry?.getAttribute("position").count ?? 0 }; }
}

/** Continuous stream reconstruction from solver parcel centres and conserved
 * per-parcel volumes. No added spray, random motion, or renderer-side gravity.
 * Cross sections are volume-normalised over the accepted centreline segments.
 */
export function jetGeometryData(frame: Pick<VesselRenderFrame, "jets" | "parcels" | "timeSeconds" | "emissionStepSeconds">) {
  if (!Number.isFinite(frame.timeSeconds) || frame.timeSeconds < 0 ||
      !Number.isFinite(frame.emissionStepSeconds) || frame.emissionStepSeconds <= 0)
    throw new RangeError("A jet reconstruction requires the accepted emission timestep");
  const positions: number[] = [], normals: number[] = [], indices: number[] = [], thickness: number[] = [];
  let volumeM3 = 0;
  const groups = new Map<string, VesselRenderFrame["parcels"][number][]>();
  for (const p of frame.parcels) { const list = groups.get(p.holeId) ?? []; list.push(p); groups.set(p.holeId, list); }
  const segments: { hole: string; parcels: VesselRenderFrame["parcels"][number][] }[] = [];
  for (const [hole, parcels] of groups) {
    parcels.sort((a, b) => b.emissionTimeSeconds - a.emissionTimeSeconds || b.id - a.id);
    let current: VesselRenderFrame["parcels"][number][] = [];
    for (const p of parcels) {
      if (current.length && current[current.length - 1]!.emissionTimeSeconds - p.emissionTimeSeconds > frame.emissionStepSeconds * (1 + 1e-6)) {
        segments.push({ hole, parcels: current }); current = [];
      }
      current.push(p);
    }
    if (current.length) segments.push({ hole, parcels: current });
  }
  for (const { hole, parcels } of segments) {
    const source = frame.timeSeconds - parcels[0]!.emissionTimeSeconds <= frame.emissionStepSeconds * (1 + 1e-6)
      ? frame.jets.find(j => j.holeId === hole && j.flowM3S > 0) : undefined;
    const samples = parcels.map(p => ({ point: new Vector3(...p.positionM), volume: p.volumeM3 }));
    const total = parcels.reduce((s, p) => s + p.volumeM3, 0);
    if (source && samples[0]!.point.distanceTo(new Vector3(...source.positionM)) > 1e-10)
      samples.unshift({ point: new Vector3(...source.positionM), volume: samples[0]!.volume });
    // A detached single quadrature parcel spans one accepted emission interval
    // along its supplied instantaneous velocity. This is its display support,
    // not a simulated droplet or an extra renderer-side integration step.
    if (samples.length === 1) {
      const half = new Vector3(...parcels[0]!.velocityMS).multiplyScalar(frame.emissionStepSeconds * .5);
      if (half.lengthSq() > 1e-24) {
        const center = samples[0]!.point;
        samples[0] = { point: center.clone().sub(half), volume: total };
        samples.push({ point: center.clone().add(half), volume: total });
      }
    }
    if (samples.length < 2) continue;
    const compact = samples.filter((p, i) => i === 0 || p.point.distanceTo(samples[i - 1]!.point) > 1e-10);
    if (compact.length < 2) continue;
    const lengths = compact.slice(1).map((p, i) => p.point.distanceTo(compact[i]!.point));
    // More densely spaced volume parcels imply a larger local cross section.
    // This resolves gravity/pulse stretching instead of painting a fixed-width
    // pipe along the ballistic trajectory.
    const radii = compact.map((p, i) => {
      const span = ((lengths[Math.max(0, i - 1)] ?? 0) + (lengths[Math.min(lengths.length - 1, i)] ?? 0)) / 2;
      return Math.sqrt(p.volume / (Math.PI * Math.max(span, 1e-12)));
    });
    let reconstructedVolume = 0;
    for (let i = 0; i < lengths.length; i++)
      reconstructedVolume += Math.PI * lengths[i]! * (radii[i]! ** 2 + radii[i]! * radii[i + 1]! + radii[i + 1]! ** 2) / 3;
    const scale = Math.sqrt(total / reconstructedVolume), base = positions.length / 3, startIndex = indices.length, sides = 12;
    let previousTangent: Vector3 | undefined, transportedNormal: Vector3 | undefined;
    const ringTangents: Vector3[] = [];
    // A connected integral stream is only meaningful while the resolved radius
    // remains small compared with its path. No artificial breakup is inferred.
    for (let i = 0; i < compact.length; i++) {
      const p = compact[i]!.point, radius = radii[i]! * scale;
      const tangent = compact[Math.min(compact.length - 1, i + 1)]!.point.clone().sub(compact[Math.max(0, i - 1)]!.point).normalize();
      if (previousTangent && transportedNormal) transportedNormal.applyQuaternion(new Quaternion().setFromUnitVectors(previousTangent, tangent));
      else transportedNormal = tangent.clone().cross(Math.abs(tangent.y) < .85 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0)).normalize();
      const a = transportedNormal.clone(), b = tangent.clone().cross(a).normalize();
      const prior = Math.max(0, i - 1), next = Math.min(compact.length - 1, i + 1);
      const span = compact[next]!.point.distanceTo(compact[prior]!.point);
      const radiusSlope = (radii[next]! - radii[prior]!) * scale / Math.max(span, 1e-12);
      for (let j = 0; j < sides; j++) {
        const angle = j * 2 * Math.PI / sides, n = a.clone().multiplyScalar(Math.cos(angle)).addScaledVector(b, Math.sin(angle));
        positions.push((p.x + n.x * radius) * 1000, (p.y + n.y * radius) * 1000, (p.z + n.z * radius) * 1000);
        thickness.push(radius * 2);
        const normal = n.addScaledVector(tangent, -radiusSlope).normalize();
        normals.push(normal.x, normal.y, normal.z);
        if (i < compact.length - 1) {
          const u = base + i * sides + j, v = base + i * sides + (j + 1) % sides;
          indices.push(u, v, u + sides, v, v + sides, u + sides);
        }
      }
      previousTangent = tangent; ringTangents.push(tangent);
    }
    // Close the finite liquid segment without inventing a breakup/capillary
    // shape. These are integral parcel end sections, not hollow stream walls.
    for (const end of [0, compact.length - 1]) {
      const p = compact[end]!.point, n = ringTangents[end]!.clone().multiplyScalar(end === 0 ? -1 : 1);
      const center = positions.length / 3; positions.push(p.x * 1000, p.y * 1000, p.z * 1000); normals.push(n.x, n.y, n.z);
      thickness.push(radii[end]! * scale * 2);
      for (let j = 0; j < sides; j++) {
        const u = base + end * sides + j, v = base + end * sides + (j + 1) % sides;
        if (end === 0) indices.push(center, v, u); else indices.push(center, u, v);
      }
    }
    // The displayed cross sections are polygons and their planes turn along the
    // curve. Correct against the actual closed triangle mesh, not πr² alone.
    const signed = signedMeshVolume(positions, indices, startIndex, indices.length, compact[0]!.point);
    if (!Number.isFinite(signed) || Math.abs(signed) <= 0) throw new RangeError("Degenerate accepted stream reconstruction");
    const correction = Math.sqrt(total / Math.abs(signed));
    for (let i = 0; i < compact.length; i++) {
      const p = compact[i]!.point, tangent = ringTangents[i]!;
      const prior = Math.max(0, i - 1), next = Math.min(compact.length - 1, i + 1);
      const span = compact[next]!.point.distanceTo(compact[prior]!.point);
      const radiusSlope = (radii[next]! - radii[prior]!) * scale * correction / Math.max(span, 1e-12);
      for (let j = 0; j < sides; j++) {
        const offset = (base + i * sides + j) * 3;
        const radial = new Vector3(positions[offset]! / 1000 - p.x, positions[offset + 1]! / 1000 - p.y, positions[offset + 2]! / 1000 - p.z);
        positions[offset] = (p.x + radial.x * correction) * 1000;
        positions[offset + 1] = (p.y + radial.y * correction) * 1000;
        positions[offset + 2] = (p.z + radial.z * correction) * 1000;
        thickness[base + i * sides + j] = radii[i]! * scale * correction * 2;
        const normal = radial.normalize().addScaledVector(tangent, -radiusSlope).normalize();
        normals[offset] = normal.x; normals[offset + 1] = normal.y; normals[offset + 2] = normal.z;
      }
    }
    thickness[base + compact.length * sides] = radii[0]! * scale * correction * 2;
    thickness[base + compact.length * sides + 1] = radii[radii.length - 1]! * scale * correction * 2;
    volumeM3 += total;
  }
  const packedPositions = new Float32Array(positions), packedIndices = new Uint32Array(indices);
  const actualVolumeM3 = Math.abs(signedMeshVolume(packedPositions, packedIndices, 0, indices.length, new Vector3()));
  return { positions: packedPositions, normals: new Float32Array(normals), indices: packedIndices,
    thicknessM: new Float32Array(thickness), volumeM3: actualVolumeM3, inputVolumeM3: volumeM3 };
}

function signedMeshVolume(positions: ArrayLike<number>, indices: ArrayLike<number>, start: number, end: number, originM: Vector3) {
  let sum = 0;
  for (let i = start; i < end; i += 3) {
    const a = indices[i]! * 3, b = indices[i + 1]! * 3, c = indices[i + 2]! * 3;
    const ax = positions[a]! / 1000 - originM.x, ay = positions[a + 1]! / 1000 - originM.y, az = positions[a + 2]! / 1000 - originM.z;
    const bx = positions[b]! / 1000 - originM.x, by = positions[b + 1]! / 1000 - originM.y, bz = positions[b + 2]! / 1000 - originM.z;
    const cx = positions[c]! / 1000 - originM.x, cy = positions[c + 1]! / 1000 - originM.y, cz = positions[c + 2]! / 1000 - originM.z;
    sum += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
  }
  return sum / 6;
}
