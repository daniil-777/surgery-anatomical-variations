import {
  ACESFilmicToneMapping, BackSide, BufferAttribute, BufferGeometry, Color, CylinderGeometry,
  DirectionalLight, DoubleSide, DynamicDrawUsage, Group, HemisphereLight, LineBasicMaterial, LineSegments,
  Material, Mesh, MeshBasicMaterial, MeshPhysicalMaterial, OrthographicCamera, PerspectiveCamera, PlaneGeometry, PMREMGenerator,
  RingGeometry, Scene, SRGBColorSpace, Sprite, SpriteMaterial, CanvasTexture, Vector3,
  WebGLRenderer, type WebGLRenderTarget,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { registerSceneRecordingSource } from "../../sceneRecordingSource";

export interface ArteryRendererOptions {
  radiusM: number;
  lengthM: number;
  onError?: (message: string) => void;
}
export interface ArteryVelocityFrame {
  axialVelocityMS: ArrayLike<number>;
  radialCentresM: ArrayLike<number>;
  timeSeconds: number;
  /** Per-radius integral of accepted-step velocity × dt since the previous
   * frame. Preserves trajectories across display batching and flow reversal.
   */
  axialDisplacementM?: ArrayLike<number>;
}

/** A rigid straight-tube visualization, not an additional fluid solver.
 * Geometry is measured in lumen radii; tracer integration remains in metres.
 * The longitudinal cut plane and tracer streaks are schematic field displays.
 */
export class ArteryRenderer {
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: WebGLRenderer;
  private readonly world = new Scene();
  private readonly camera = new PerspectiveCamera(38, 1, .01, 1000);
  private readonly controls: OrbitControls;
  private readonly observer: ResizeObserver;
  private readonly recording: ReturnType<typeof registerSceneRecordingSource>;
  private environment: WebGLRenderTarget | undefined;
  private readonly full = new Group();
  private readonly cut = new Group();
  private readonly geometries = new Set<BufferGeometry>();
  private readonly materials = new Set<Material>();
  private readonly textures = new Set<CanvasTexture>();
  private readonly slice: Mesh<PlaneGeometry, MeshPhysicalMaterial | MeshBasicMaterial>;
  private readonly sliceBlood: MeshPhysicalMaterial;
  private readonly sliceVelocity: MeshBasicMaterial;
  private readonly sliceColours: Float32Array;
  private readonly bloodFull: MeshPhysicalMaterial;
  private readonly bloodCut: MeshPhysicalMaterial;
  private readonly tracerGeometry: BufferGeometry;
  private readonly tracerPositions = new Float32Array(36 * 6);
  private readonly tracerColours = new Float32Array(36 * 6);
  private readonly tracerX = new Float64Array(36);
  private readonly tracerR = new Float64Array(36);
  private readonly tracerY = new Float64Array(36);
  private readonly tracers: LineSegments<BufferGeometry, LineBasicMaterial>;
  private readonly colourScratch = new Color();
  private readonly cold = new Color("#2479b7");
  private readonly neutral = new Color("#e3e6e5");
  private readonly warm = new Color("#ed7934");
  private readonly legendWorld = new Scene();
  private readonly legendCamera = new OrthographicCamera(0, 1, 1, 0, 0, 2);
  private readonly legendCanvas = document.createElement("canvas");
  private legendTexture: CanvasTexture | undefined;
  private legendSprite: Sprite | undefined;
  private legendKey = "";
  private legendUpdated = -Infinity;
  private legendPending = false;
  private centres = new Float64Array(0);
  private velocities = new Float64Array(0);
  private maximumSpeed = 0;
  private lastTime = -1;
  private wraps = 0;
  private dirty = true;
  private lost = false;
  private disposed = false;
  private mode: "blood" | "velocity" = "blood";
  private cutaway = true;
  private displayInitialized = false;
  private detachCaptureAbort: (() => void) | undefined;
  private readonly homePosition: Vector3;
  private readonly viewExtent: number;
  private aspectFit = 1;

  constructor(private readonly host: HTMLElement, private readonly options: ArteryRendererOptions) {
    if (![options.radiusM, options.lengthM].every(v => Number.isFinite(v) && v > 0)) {
      throw new RangeError("Artery radius and length must be finite positive metres");
    }
    const length = options.lengthM / options.radiusM, extent = Math.max(length, 4);
    this.viewExtent = extent;
    this.renderer = new WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
    this.canvas = this.renderer.domElement;
    try {
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute("aria-label", "Rigid artery flow visualization. Drag or use arrow keys to orbit; plus and minus zoom; Home resets the camera.");
    this.canvas.style.cssText = "display:block;width:100%;height:100%;touch-action:none";
    host.appendChild(this.canvas);
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.world.background = new Color("#111820");
    const room = new RoomEnvironment(), pmrem = new PMREMGenerator(this.renderer);
    try { this.environment = pmrem.fromScene(room, .04); this.world.environment = this.environment.texture; }
    finally { room.dispose(); pmrem.dispose(); }
    this.world.add(new HemisphereLight("#ddefff", "#241719", 1.4));
    const key = new DirectionalLight("#fff1de", 3.0); key.position.set(extent * .2, extent * .5, extent * .7);
    const fill = new DirectionalLight("#b5d4f5", 1.3); fill.position.set(-extent * .5, extent * .3, -extent * .4);
    this.world.add(key, fill, this.full, this.cut);
    const outer = this.material(new MeshPhysicalMaterial({ color: "#aa6664", roughness: .44, clearcoat: .2, clearcoatRoughness: .3, side: DoubleSide }));
    const inner = this.material(new MeshPhysicalMaterial({ color: "#873c42", roughness: .32, clearcoat: .3, side: BackSide }));
    const ends = this.material(new MeshPhysicalMaterial({ color: "#d29a91", roughness: .55, side: DoubleSide }));
    const outerFull = this.material(new MeshPhysicalMaterial({ color: "#bd817a", roughness: .3, transparent: true, opacity: .2, depthWrite: false, side: DoubleSide }));
    this.bloodFull = this.material(new MeshPhysicalMaterial({ color: "#690a13", roughness: .2, clearcoat: .75, clearcoatRoughness: .16 }));
    this.bloodCut = this.material(new MeshPhysicalMaterial({ color: "#690a13", roughness: .2, clearcoat: .75, clearcoatRoughness: .16 }));
    for (const [group, angle, arc] of [[this.full, 0, 2 * Math.PI], [this.cut, Math.PI / 2, Math.PI]] as const) {
      const wall = new Mesh(this.geometry(new CylinderGeometry(1.12, 1.12, length, 96, 1, true, angle, arc)), group === this.full ? outerFull : outer);
      wall.rotation.z = Math.PI / 2; group.add(wall);
      if (group === this.cut) {
        const lumen = new Mesh(this.geometry(new CylinderGeometry(1, 1, length, 96, 1, true, angle, arc)), inner);
        lumen.rotation.z = Math.PI / 2; group.add(lumen);
        for (const side of [-1, 1]) {
          const rim = new Mesh(this.geometry(new PlaneGeometry(length, .12)), ends);
          rim.position.set(0, side * 1.06, 0); group.add(rim);
        }
      }
      const fluid = new Mesh(this.geometry(new CylinderGeometry(.99, .99, length * .999, 96, 1, false, angle, arc)),
        group === this.full ? this.bloodFull : this.bloodCut);
      fluid.rotation.z = Math.PI / 2; group.add(fluid);
      for (const side of [-1, 1]) {
        const ring = new Mesh(this.geometry(new RingGeometry(1, 1.12, 96, 1, angle, arc)), ends);
        ring.rotation.y = -Math.PI / 2; ring.position.x = side * length * .5; group.add(ring);
      }
    }
    const sliceGeometry = this.geometry(new PlaneGeometry(length * .999, 1.98, 1, 64));
    this.sliceColours = new Float32Array(sliceGeometry.attributes.position!.count * 3);
    sliceGeometry.setAttribute("color", new BufferAttribute(this.sliceColours, 3).setUsage(DynamicDrawUsage));
    this.sliceBlood = this.material(new MeshPhysicalMaterial({
      color: "#ffffff", vertexColors: true, roughness: .27, clearcoat: .45, clearcoatRoughness: .24, side: DoubleSide,
    }));
    // A quantitative field must not be recoloured by lighting or tone mapping.
    this.sliceVelocity = this.material(new MeshBasicMaterial({ vertexColors: true, toneMapped: false, side: DoubleSide }));
    this.slice = new Mesh(sliceGeometry, this.sliceBlood);
    this.slice.position.z = .002;
    this.world.add(this.slice);
    this.tracerGeometry = this.geometry(new BufferGeometry());
    this.tracerGeometry.setAttribute("position", new BufferAttribute(this.tracerPositions, 3).setUsage(DynamicDrawUsage));
    this.tracerGeometry.setAttribute("color", new BufferAttribute(this.tracerColours, 3).setUsage(DynamicDrawUsage));
    this.tracers = new LineSegments(this.tracerGeometry, this.material(new LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: .92, depthWrite: false, toneMapped: false,
    })));
    this.tracers.frustumCulled = false;
    this.world.add(this.tracers);
    for (let i = 0; i < this.tracerX.length; ++i) {
      const lane = Math.floor(i / 4);
      this.tracerY[i] = -.88 + lane * .22;
      this.tracerR[i] = Math.hypot(this.tracerY[i]!, .012) * options.radiusM;
      this.tracerX[i] = (((i % 4) / 4 + lane * .071) % 1 - .5) * options.lengthM;
    }
    this.addScale(length);
    this.createLegend();
    this.homePosition = new Vector3(extent * .55, extent * .30, extent * .95);
    this.camera.position.copy(this.homePosition);
    this.camera.near = extent * .002; this.camera.far = extent * 20;
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = false;
    this.controls.enablePan = true;
    this.controls.minDistance = Math.max(2, extent * .2);
    this.controls.maxDistance = extent * 4;
    this.controls.target.set(0, 0, 0); this.controls.update(); this.controls.saveState();
    this.controls.addEventListener("change", this.changed);
    this.canvas.addEventListener("keydown", this.key);
    this.canvas.addEventListener("pointerdown", this.focus);
    this.canvas.addEventListener("webglcontextlost", this.contextLost);
    this.recording = registerSceneRecordingSource({
      renderer: this.renderer, camera: this.camera, host, label: "Rigid artery · radial velocity field",
      draw: () => this.render(), available: () => !this.lost && !this.disposed,
    });
    // The shared lease restores explicitly. Also honor AbortSignal for this
    // owner so an abandoned recorder cannot retain native 4K dimensions.
    const prepare = this.recording.source.prepare.bind(this.recording.source);
    this.recording.source.prepare = target => {
      const lease = prepare(target);
      let restored = false;
      const detach = () => {
        target.signal.removeEventListener("abort", restore);
        if (this.detachCaptureAbort === detach) this.detachCaptureAbort = undefined;
      };
      const restore = () => { if (restored) return; restored = true; detach(); lease.restore(); this.resize(); };
      this.detachCaptureAbort = detach;
      target.signal.addEventListener("abort", restore, { once: true });
      return { restore };
    };
    this.observer = new ResizeObserver(this.resize); this.observer.observe(host);
    this.resize();
    this.refreshField();
    this.setDisplay("blood", true);
    } catch (error) { this.dispose(); throw error; }
  }

  private geometry<T extends BufferGeometry>(value: T): T { this.geometries.add(value); return value; }
  private material<T extends Material>(value: T): T { this.materials.add(value); return value; }
  private createLegend() {
    this.legendCanvas.width = 1536; this.legendCanvas.height = 384;
    this.legendTexture = new CanvasTexture(this.legendCanvas);
    this.legendTexture.colorSpace = SRGBColorSpace; this.textures.add(this.legendTexture);
    this.legendSprite = new Sprite(this.material(new SpriteMaterial({
      map: this.legendTexture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
    })));
    this.legendSprite.center.set(0, 1); this.legendWorld.add(this.legendSprite); this.legendCamera.position.z = 1;
    this.refreshLegend(true);
  }
  /** One small reusable texture, at most ten uploads per second while running.
   * The legend is rendered inside the native canvas and therefore in recordings.
   */
  private refreshLegend(force = false) {
    if (!this.legendTexture) return;
    const peak = this.maximumSpeed === 0 ? "0" : this.maximumSpeed.toPrecision(3);
    const key = this.mode === "blood" ? "blood" : `velocity/${peak}`;
    if (key === this.legendKey) { this.legendPending = false; return; }
    this.legendPending = true;
    const now = performance.now(); if (!force && now - this.legendUpdated < 100) return;
    const ctx = this.legendCanvas.getContext("2d"); if (!ctx) return;
    ctx.clearRect(0, 0, 1536, 384);
    ctx.fillStyle = "rgba(10,18,27,0.92)"; ctx.beginPath(); ctx.roundRect(0, 0, 1536, 384, 28); ctx.fill();
    ctx.textBaseline = "middle"; ctx.fillStyle = "#9facba"; ctx.font = "500 38px sans-serif";
    ctx.fillText("RIGID STRAIGHT ARTERY  ·  SCHEMATIC", 48, 57);
    ctx.fillStyle = "#f2f5f7"; ctx.font = "600 58px sans-serif";
    ctx.fillText(this.mode === "velocity" ? "AXIAL VELOCITY" : "BLOOD MATERIAL", 48, 132);
    ctx.font = "400 42px sans-serif"; ctx.fillStyle = "#c6d0d9";
    if (this.mode === "velocity") {
      ctx.fillText(`−${peak}  ↔  +${peak} m/s  ·  passive tracers`, 48, 208);
      const ramp = ctx.createLinearGradient(48, 0, 680, 0);
      ramp.addColorStop(0, "#2479b7"); ramp.addColorStop(.5, "#e3e6e5"); ramp.addColorStop(1, "#ed7934");
      ctx.fillStyle = ramp; ctx.fillRect(48, 272, 632, 20);
      ctx.fillStyle = "#9facba"; ctx.font = "400 34px sans-serif";
      ctx.fillText("reverse", 48, 335); ctx.fillText("0", 349, 335); ctx.fillText("forward", 560, 335);
      ctx.fillText("20 ms streak scale", 800, 282);
    } else {
      ctx.fillText("Illustrative optics  ·  passive tracers", 48, 208);
      ctx.fillStyle = "#9facba"; ctx.font = "400 36px sans-serif";
      ctx.fillText("Rigid wall  ·  no free-surface bleeding", 48, 292);
    }
    this.legendTexture.needsUpdate = true; this.legendKey = key;
    this.legendUpdated = now; this.legendPending = false;
  }
  private addScale(length: number) {
    const desired = this.options.lengthM * .25;
    const decade = 10 ** Math.floor(Math.log10(desired));
    const scaleM = [1, 2, 5].map(v => v * decade).filter(v => v <= desired).at(-1) ?? decade;
    const scale = scaleM / this.options.radiusM, x = -length * .5, y = -1.65;
    const vertices = new Float32Array([x, y, .05, x + scale, y, .05, x, y - .08, .05, x, y + .08, .05,
      x + scale, y - .08, .05, x + scale, y + .08, .05]);
    const geometry = this.geometry(new BufferGeometry()); geometry.setAttribute("position", new BufferAttribute(vertices, 3));
    this.world.add(new LineSegments(geometry, this.material(new LineBasicMaterial({ color: "#b8c4cc" }))));
    const canvas = document.createElement("canvas"); canvas.width = 384; canvas.height = 96;
    const ctx = canvas.getContext("2d"); if (!ctx) return;
    ctx.font = "500 42px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = "#d4dde3";
    ctx.fillText(`${Number((scaleM * 1000).toPrecision(3))} mm`, 192, 48);
    const texture = new CanvasTexture(canvas); texture.colorSpace = SRGBColorSpace; this.textures.add(texture);
    const sprite = new Sprite(this.material(new SpriteMaterial({ map: texture, transparent: true, depthWrite: false })));
    sprite.position.set(x + scale * .5, y - .35, .05); sprite.scale.set(1.65, .4125, 1); this.world.add(sprite);
  }
  private readonly changed = () => { this.dirty = true; };
  private readonly focus = () => { this.canvas.focus({ preventScroll: true }); };
  private readonly resize = () => {
    if (this.disposed || this.lost || this.recording?.active) return;
    const width = Math.max(16, this.host.clientWidth), height = Math.max(16, this.host.clientHeight);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(width, height);
    this.camera.aspect = width / height;
    // Preserve orbit and user zoom while fitting the long tube on portrait
    // screens. Capture uses its own fixed projection and never enters this path.
    const fit = Math.max(1, 1.8 / this.camera.aspect);
    this.camera.position.sub(this.controls.target).multiplyScalar(fit / this.aspectFit).add(this.controls.target);
    this.aspectFit = fit; this.controls.maxDistance = this.viewExtent * 4 * fit;
    this.camera.far = Math.max(this.viewExtent * 20, this.camera.position.length() * 4);
    this.camera.updateProjectionMatrix(); this.controls.update(); this.dirty = true;
  };
  private readonly key = (event: KeyboardEvent) => {
    if (this.disposed || this.lost || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "=", "-", "Home"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Home") { this.controls.reset(); this.camera.position.copy(this.homePosition).multiplyScalar(this.aspectFit); this.controls.target.set(0, 0, 0); }
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
    event.preventDefault();
    if (this.disposed || this.lost) return;
    this.lost = true; this.controls.enabled = false;
    this.detachCaptureAbort?.();
    this.options.onError?.("The artery graphics context was lost. Playback has stopped; reset the artery view to recover.");
  };

  /** Repeated or older simulation timestamps never move tracers. Prefer the
   * accepted-step displacement integral. The velocity × dt fallback is intended
   * for constant-field fixtures; optional dt bounds that fallback interval.
   */
  update(frame: ArteryVelocityFrame, dtSeconds?: number) {
    if (this.disposed || this.lost) return;
    if (!Number.isFinite(frame.timeSeconds) || frame.timeSeconds < 0
      || (dtSeconds !== undefined && (!Number.isFinite(dtSeconds) || dtSeconds < 0))) throw new RangeError("Artery display time must be finite non-negative seconds");
    if (frame.timeSeconds < this.lastTime) return;
    const count = frame.axialVelocityMS.length;
    if (!Number.isInteger(count) || count < 1 || count !== frame.radialCentresM.length) throw new RangeError("Artery velocity and radial-centre arrays must have equal nonzero length");
    if (frame.axialDisplacementM !== undefined && frame.axialDisplacementM.length !== count) {
      throw new RangeError("Artery displacement integral must match the radial profile length");
    }
    let maximum = 0, profileChanged = this.centres.length !== count;
    for (let i = 0; i < count; ++i) {
      const radius = frame.radialCentresM[i]!, velocity = frame.axialVelocityMS[i]!;
      if (!Number.isFinite(radius) || radius < 0 || radius >= this.options.radiusM
        || (i > 0 && radius <= frame.radialCentresM[i - 1]!) || !Number.isFinite(velocity)) throw new RangeError("Artery profile must contain finite velocities at strictly increasing lumen radii");
      if (frame.axialDisplacementM !== undefined && !Number.isFinite(frame.axialDisplacementM[i])) {
        throw new RangeError("Artery displacement integral must contain finite metres");
      }
      maximum = Math.max(maximum, Math.abs(velocity));
      if (this.centres[i] !== radius || this.velocities[i] !== velocity) profileChanged = true;
    }
    if (this.centres.length !== count) { this.centres = new Float64Array(count); this.velocities = new Float64Array(count); }
    this.centres.set(frame.radialCentresM); this.velocities.set(frame.axialVelocityMS); this.maximumSpeed = maximum;
    const elapsed = this.lastTime < 0 ? 0 : Math.max(0, frame.timeSeconds - this.lastTime);
    const dt = dtSeconds === undefined ? elapsed : Math.min(elapsed, dtSeconds);
    if (dt > 0) for (let i = 0; i < this.tracerX.length; ++i) {
      const displacement = frame.axialDisplacementM === undefined ? this.velocity(this.tracerR[i]!) * dt
        : this.interpolate(this.tracerR[i]!, frame.axialDisplacementM);
      const next = this.tracerX[i]! + displacement;
      const turns = Math.floor((next + this.options.lengthM * .5) / this.options.lengthM);
      this.tracerX[i] = next - turns * this.options.lengthM;
      this.wraps += Math.abs(turns); // Visualization recycling only, never solver mass or flow.
    }
    this.lastTime = frame.timeSeconds;
    if (!profileChanged && (dt === 0 || (maximum === 0 && frame.axialDisplacementM === undefined))) return;
    this.refreshField(); this.refreshLegend(); this.dirty = true;
  }
  private velocity(radiusM: number) { return this.interpolate(radiusM, this.velocities); }
  private interpolate(radiusM: number, values: ArrayLike<number>) {
    const n = this.centres.length; if (!n || radiusM >= this.options.radiusM) return 0;
    if (radiusM <= this.centres[0]!) return values[0]!;
    for (let i = 1; i < n; ++i) if (radiusM <= this.centres[i]!) {
      const t = (radiusM - this.centres[i - 1]!) / (this.centres[i]! - this.centres[i - 1]!);
      return values[i - 1]! * (1 - t) + values[i]! * t;
    }
    return values[n - 1]! * (this.options.radiusM - radiusM) / (this.options.radiusM - this.centres[n - 1]!);
  }
  private colour(velocity: number) {
    if (this.mode === "blood") return this.colourScratch.set("#740b15");
    return this.colourScratch.copy(this.neutral).lerp(velocity < 0 ? this.cold : this.warm,
      this.maximumSpeed > 0 ? Math.min(1, Math.abs(velocity) / this.maximumSpeed) : 0);
  }
  private refreshField() {
    const positions = this.slice.geometry.attributes.position!;
    for (let i = 0; i < positions.count; ++i) {
      const colour = this.colour(this.velocity(Math.abs(positions.getY(i)) * this.options.radiusM));
      colour.toArray(this.sliceColours, i * 3);
    }
    this.slice.geometry.attributes.color!.needsUpdate = true;
    // Streak length is an instantaneous velocity glyph at a fixed 20 ms scale.
    // Head positions are independently advected in actual simulation seconds.
    const half = this.options.lengthM * .5, exposureSeconds = .020;
    for (let i = 0; i < this.tracerX.length; ++i) {
      const v = this.velocity(this.tracerR[i]!), head = this.tracerX[i]!;
      const tail = Math.max(-half, Math.min(half, head - v * exposureSeconds));
      const offset = i * 6;
      this.tracerPositions[offset] = tail / this.options.radiusM;
      this.tracerPositions[offset + 1] = this.tracerY[i]!; this.tracerPositions[offset + 2] = .012;
      this.tracerPositions[offset + 3] = head / this.options.radiusM;
      this.tracerPositions[offset + 4] = this.tracerY[i]!; this.tracerPositions[offset + 5] = .012;
      const colour = this.colourScratch.set(this.mode === "blood" ? "#ef9b8a" : "#102333");
      colour.toArray(this.tracerColours, offset); colour.toArray(this.tracerColours, offset + 3);
    }
    this.tracerGeometry.attributes.position!.needsUpdate = true; this.tracerGeometry.attributes.color!.needsUpdate = true;
  }
  setDisplay(mode: "blood" | "velocity", cutaway: boolean) {
    if (this.disposed || this.lost) return;
    if (this.displayInitialized && this.mode === mode && this.cutaway === cutaway) return;
    this.displayInitialized = true;
    this.mode = mode; this.cutaway = cutaway; this.full.visible = !cutaway; this.cut.visible = cutaway;
    this.slice.visible = cutaway || mode === "velocity";
    this.slice.material = mode === "velocity" ? this.sliceVelocity : this.sliceBlood;
    this.tracers.visible = cutaway;
    this.bloodFull.transparent = mode === "velocity"; this.bloodFull.opacity = mode === "velocity" ? .16 : 1;
    this.bloodFull.depthWrite = mode !== "velocity"; this.bloodFull.needsUpdate = true;
    this.bloodFull.color.set(mode === "velocity" ? "#e3e6e5" : "#690a13");
    this.bloodCut.color.set(mode === "velocity" ? "#e3e6e5" : "#690a13");
    this.refreshField(); this.refreshLegend(true); this.dirty = true;
  }
  get needsRender() {
    return !this.disposed && !this.lost && (this.dirty || this.recording.active
      || (this.legendPending && performance.now() - this.legendUpdated >= 100));
  }
  get visualState() {
    return { timeSeconds: this.lastTime, tracerWraps: this.wraps, tracerCount: this.tracerX.length,
      tracerAxialMetres: Array.from(this.tracerX), maximumSpeedMS: this.maximumSpeed, cutaway: this.cutaway, contextLost: this.lost };
  }
  get cameraDistanceM() { return this.camera.position.distanceTo(this.controls.target) * this.options.radiusM; }
  render() {
    if (this.disposed || this.lost) return;
    this.refreshLegend();
    this.renderer.render(this.world, this.camera);
    if (this.legendSprite) {
      const width = this.canvas.width, height = this.canvas.height, scale = height / 720;
      const margin = Math.max(8, 20 * scale), legendWidth = Math.min(width - 2 * margin, 440 * scale);
      this.legendCamera.right = width; this.legendCamera.top = height; this.legendCamera.updateProjectionMatrix();
      this.legendSprite.position.set(margin, height - margin, 0); this.legendSprite.scale.set(legendWidth, legendWidth / 4, 1);
      const autoClear = this.renderer.autoClear;
      try { this.renderer.autoClear = false; this.renderer.clearDepth(); this.renderer.render(this.legendWorld, this.legendCamera); }
      finally { this.renderer.autoClear = autoClear; }
    }
    this.dirty = false;
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.detachCaptureAbort?.(); this.recording?.dispose(); this.observer?.disconnect(); this.controls?.dispose();
    this.controls?.removeEventListener("change", this.changed);
    this.canvas.removeEventListener("keydown", this.key); this.canvas.removeEventListener("pointerdown", this.focus);
    this.canvas.removeEventListener("webglcontextlost", this.contextLost);
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    for (const texture of this.textures) texture.dispose();
    this.environment?.dispose(); this.environment = undefined; this.world.clear(); this.legendWorld.clear();
    this.renderer.dispose(); this.renderer.forceContextLoss(); this.canvas.remove();
  }
}
