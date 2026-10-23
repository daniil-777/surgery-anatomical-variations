/// <reference types="@webgpu/types" />
import { Matrix4, PerspectiveCamera, Vector3 } from "three";
import { registerNativeSceneRecordingSource } from "../sceneRecordingSource";
import type { BloodRuntime } from "./runtime";
import { BloodSurface, type BloodSurfaceProfile } from "./surface";

/** Accepted-state surface and diagnostic particles. Blood optics are illustrative. */
export class BloodRenderer {
  private pipeline: GPURenderPipeline;
  private bindGroup: GPUBindGroup;
  private uniform: GPUBuffer;
  private depth: GPUTexture | undefined;
  private context: GPUCanvasContext;
  private observer: ResizeObserver;
  private unregister: () => void;
  private release: (() => void) | undefined;
  private camera = new PerspectiveCamera(38, 1, .0001, 1);
  private yaw = .65;
  private pitch = .4;
  private distance = 2.7;
  private drag: { x: number; y: number } | undefined;
  private capture = false;
  private disposed = false;
  private dirty = true;
  private lastPresentation = "";
  private surface: BloodSurface;
  private readonly options: { compactStorage: boolean };
  mode: "particles" | "surface" = "surface";
  colour: "red" | "speed" = "red";
  surfaceFilter: "bilateral" | "narrow-range" = "narrow-range";
  get needsRender() { return this.dirty || this.capture || this.lastPresentation !== `${this.mode}/${this.colour}/${this.surfaceFilter}`; }
  constructor(readonly canvas: HTMLCanvasElement, readonly runtime: BloodRuntime, options: { compactStorage?: boolean } = {}) {
    this.options = { compactStorage: options.compactStorage ?? true };
    const { device, count, scene } = runtime;
    const context = canvas.getContext("webgpu"); if (!context) throw new Error("Could not create a WebGPU canvas");
    this.context = context;
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: "opaque" });
    this.uniform = device.createBuffer({ size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const module = device.createShaderModule({ label: "blood/accepted-state diagnostic", code: `
      struct State { p: array<vec4<f32>,${count}>, v: array<vec4<f32>,${count}> }
      struct View { vp: mat4x4<f32>, right: vec4<f32>, up: vec4<f32>, eye: vec4<f32>, options: vec4<f32> }
      @group(0) @binding(0) var<storage,read> A: State;
      @group(0) @binding(1) var<uniform> view: View;
      struct Vertex { @builtin(position) clip: vec4<f32>, @location(0) uv: vec2<f32>,
        @location(1) center: vec3<f32>, @location(2) speed: f32 }
      @vertex fn vertex(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> Vertex {
        let corners=array<vec2<f32>,6>(vec2(-1.,-1.),vec2(1.,-1.),vec2(-1.,1.),vec2(-1.,1.),vec2(1.,-1.),vec2(1.,1.));
        let uv=corners[vertex]; let p=A.p[instance].xyz-vec3<f32>(${scene.lengthM / 2});
        var out:Vertex; out.center=p; out.uv=uv; out.speed=length(A.v[instance].xyz);
        out.clip=view.vp*vec4(p+view.options.x*(uv.x*view.right.xyz+uv.y*view.up.xyz),1.);
        return out;
      }
      struct Fragment { @location(0) colour: vec4<f32>, @builtin(frag_depth) depth: f32 }
      @fragment fn fragment(in:Vertex) -> Fragment {
        let r2=dot(in.uv,in.uv); if(r2>1.){discard;}
        let normal=in.uv.x*view.right.xyz+in.uv.y*view.up.xyz+sqrt(1.-r2)*normalize(view.eye.xyz-in.center);
        let p=in.center+normal*view.options.x;
        let clip=view.vp*vec4(p,1.);
        let light=normalize(vec3<f32>(-.4,.7,1.));
        let eye=normalize(view.eye.xyz-p);
        let diffuse=max(dot(normal,light),0.);
        let spec=pow(max(dot(normal,normalize(light+eye)),0.),40.);
        var tint=vec3<f32>(.35,.012,.024);
        if(view.options.y>0.5){tint=mix(vec3<f32>(.03,.24,.47),vec3<f32>(.94,.38,.07),clamp(in.speed/.025,0.,1.));}
        let colour=tint*(.32+1.15*diffuse)+vec3<f32>(.55)*spec;
        var out:Fragment; out.colour=vec4(pow(colour,vec3<f32>(1./2.2)),1.);
        out.depth=clip.z/clip.w; return out;
      }` });
    this.pipeline = device.createRenderPipeline({
      label: "blood/read-only particles", layout: "auto",
      vertex: { module, entryPoint: "vertex" }, fragment: { module, entryPoint: "fragment", targets: [{ format }] },
      primitive: { topology: "triangle-list" }, depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "less" },
    });
    this.bindGroup = device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: runtime.accepted } }, { binding: 1, resource: { buffer: this.uniform } },
    ] });
    this.surface = new BloodSurface(runtime, this.uniform, format, this.options);
    this.observer = new ResizeObserver(() => { if (!this.capture) this.resize(); });
    this.observer.observe(canvas.parentElement!);
    this.unregister = registerNativeSceneRecordingSource({ kind: "scene", canvas, label: "Blood lab · experimental fluid", prepare: target => this.prepare(target) });
    this.resize();
    canvas.addEventListener("pointerdown", this.down); canvas.addEventListener("pointermove", this.move);
    canvas.addEventListener("pointerup", this.up); canvas.addEventListener("pointercancel", this.up);
    canvas.addEventListener("wheel", this.wheel, { passive: false }); canvas.addEventListener("keydown", this.key);
  }
  private allocate(width: number, height: number) {
    if (width === this.canvas.width && height === this.canvas.height && (this.options.compactStorage || this.depth)) return;
    this.canvas.width = width; this.canvas.height = height;
    this.dirty = true;
    this.depth?.destroy(); this.depth = undefined;
    if (!this.options.compactStorage) this.allocateDiagnosticDepth();
  }
  private allocateDiagnosticDepth() {
    this.depth ??= this.runtime.device.createTexture({ label: "blood/diagnostic depth", size: [this.canvas.width, this.canvas.height], format: "depth32float", usage: GPUTextureUsage.RENDER_ATTACHMENT });
  }
  get renderBytes() { return this.surface.renderBytes + (this.depth ? this.canvas.width * this.canvas.height * 4 : 0); }
  private resize() {
    if (this.disposed) return;
    const host = this.canvas.parentElement!, ratio = Math.min(devicePixelRatio, 2);
    this.allocate(Math.max(16, Math.round(host.clientWidth * ratio)), Math.max(16, Math.round(host.clientHeight * ratio)));
  }
  private prepare({ width, height, fps, signal }: { width: number; height: number; fps: number; signal: AbortSignal }) {
    if (signal.aborted) throw new DOMException("Recording cancelled", "AbortError");
    if (this.capture || this.disposed || !this.canvas.isConnected) throw new Error("The blood scene is not available");
    const max = this.runtime.device.limits.maxTextureDimension2D;
    if (![width, height].every(v => Number.isInteger(v) && v >= 16 && v <= Math.min(8192, max)) || width * height > 33_554_432 || !Number.isFinite(fps) || fps <= 0 || fps > 60) throw new Error("Unsupported recording dimensions");
    this.capture = true; this.canvas.dataset.sceneRecordingActive = "true";
    const oldStyle = this.canvas.style.cssText;
    const layout = () => {
      const host = this.canvas.parentElement!, scale = Math.min(host.clientWidth / width, host.clientHeight / height);
      Object.assign(this.canvas.style, { width: `${width * scale}px`, height: `${height * scale}px`,
        position: "absolute", left: `${(host.clientWidth - width * scale) / 2}px`, top: `${(host.clientHeight - height * scale) / 2}px` });
    };
    const observer = new ResizeObserver(layout); observer.observe(this.canvas.parentElement!);
    let restored = false;
    const restore = () => {
      if (restored) return; restored = true; this.capture = false; this.release = undefined;
      observer.disconnect(); this.canvas.style.cssText = oldStyle; delete this.canvas.dataset.sceneRecordingActive;
      signal.removeEventListener("abort", restore); if (!this.disposed) this.resize();
    };
    this.release = restore;
    try { this.allocate(width, height); layout(); signal.addEventListener("abort", restore, { once: true }); return { restore }; }
    catch (error) { restore(); throw error; }
  }
  private down = (event: PointerEvent) => {
    if (event.button !== 0) return; this.canvas.focus(); this.canvas.setPointerCapture(event.pointerId);
    this.drag = { x: event.clientX, y: event.clientY };
  };
  private move = (event: PointerEvent) => {
    if (!this.drag) return;
    this.yaw -= (event.clientX - this.drag.x) * .006; this.pitch = Math.max(-1.4, Math.min(1.4, this.pitch + (event.clientY - this.drag.y) * .006));
    this.dirty = true;
    this.drag = { x: event.clientX, y: event.clientY };
  };
  private up = (event: PointerEvent) => { this.drag = undefined; if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId); };
  private wheel = (event: WheelEvent) => { event.preventDefault(); this.distance = Math.max(1.4, Math.min(5, this.distance + event.deltaY * .002)); this.dirty = true; };
  private key = (event: KeyboardEvent) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "-", "Home"].includes(event.key)) return;
    event.preventDefault();
    this.dirty = true;
    if (event.key === "Home") { this.yaw = .65; this.pitch = .4; this.distance = 2.7; }
    if (event.key === "ArrowLeft") this.yaw -= .1; if (event.key === "ArrowRight") this.yaw += .1;
    if (event.key === "ArrowUp") this.pitch = Math.min(1.4, this.pitch + .1);
    if (event.key === "ArrowDown") this.pitch = Math.max(-1.4, this.pitch - .1);
    if (event.key === "+") this.distance = Math.max(1.4, this.distance - .1);
    if (event.key === "-") this.distance = Math.min(5, this.distance + .1);
  };
  encode = (encoder: GPUCommandEncoder, profile?: BloodSurfaceProfile, target?: GPUTextureView) => {
    if (this.disposed) return;
    this.dirty = false; this.lastPresentation = `${this.mode}/${this.colour}/${this.surfaceFilter}`;
    const distance = this.distance * this.runtime.scene.lengthM;
    // The scene is millimetres across. A generic 0.1 mm–1 m frustum loses
    // significant depth precision at overlapping particle silhouettes.
    this.camera.near = Math.max(this.runtime.scene.lengthM * .05, distance - this.runtime.scene.lengthM * 1.1);
    this.camera.far = distance + this.runtime.scene.lengthM * 1.1;
    this.camera.position.set(Math.sin(this.yaw) * Math.cos(this.pitch) * distance, Math.sin(this.pitch) * distance, Math.cos(this.yaw) * Math.cos(this.pitch) * distance);
    this.camera.aspect = this.canvas.width / this.canvas.height; this.camera.lookAt(0, 0, 0); this.camera.updateMatrixWorld(); this.camera.updateProjectionMatrix();
    // Three's default projection uses OpenGL depth [-1,1]; WebGPU uses [0,1].
    const remap = new Matrix4().set(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, .5, .5, 0, 0, 0, 1);
    const vp = remap.multiply(this.camera.projectionMatrix).multiply(this.camera.matrixWorldInverse);
    const data = new Float32Array(32); data.set(vp.elements);
    data.set(new Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0).toArray(), 16);
    data.set(new Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1).toArray(), 20);
    data.set(this.camera.position.toArray(), 24);
    data.set([this.runtime.scene.lengthM / this.runtime.scene.axis / (this.runtime.scene.fixture === "dam" ? 2 : 1) * .28, this.colour === "speed" ? 1 : 0, 0, 0], 28);
    this.runtime.device.queue.writeBuffer(this.uniform, 0, data);
    if (this.mode === "surface") {
      if (this.options.compactStorage) { this.depth?.destroy(); this.depth = undefined; }
      this.surface.filterMode = this.surfaceFilter;
      this.surface.encode(encoder, target ?? this.context.getCurrentTexture().createView(), this.canvas.width, this.canvas.height, profile); return;
    }
    this.allocateDiagnosticDepth();
    const timestampWrites = profile?.pass("diagnostic-particles");
    const pass = encoder.beginRenderPass({ label: "blood/accepted state", ...(timestampWrites ? { timestampWrites } : {}), colorAttachments: [{
      view: target ?? this.context.getCurrentTexture().createView(), clearValue: { r: .018, g: .023, b: .036, a: 1 }, loadOp: "clear", storeOp: "store",
    }], depthStencilAttachment: { view: this.depth!.createView(), depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "discard" } });
    pass.setPipeline(this.pipeline); pass.setBindGroup(0, this.bindGroup); pass.draw(6, this.runtime.count); pass.end();
  };
  dispose() {
    if (this.disposed) return; this.disposed = true; this.release?.(); this.unregister(); this.observer.disconnect();
    this.depth?.destroy(); this.depth = undefined; this.surface.dispose(); this.uniform.destroy(); this.context.unconfigure();
    this.canvas.removeEventListener("pointerdown", this.down); this.canvas.removeEventListener("pointermove", this.move);
    this.canvas.removeEventListener("pointerup", this.up); this.canvas.removeEventListener("pointercancel", this.up);
    this.canvas.removeEventListener("wheel", this.wheel); this.canvas.removeEventListener("keydown", this.key);
  }
}
