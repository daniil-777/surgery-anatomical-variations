/// <reference types="@webgpu/types" />
import type { BloodRuntime } from "./runtime";
import { trayGeometry } from "./boundary";
import { BLOOD_OPTICS_WGSL } from "./optics";

/** Interpolate only within a depth layer; missing/occluding samples are discrete. */
export const SURFACE_DEPTH_SAMPLE_WGSL = `
fn surfaceDepthTolerance(a:f32,b:f32)->f32{
  // Eight relative f32 epsilons keep opposing on-threshold samples symmetric.
  return max(abs(a),abs(b))*9.5367431640625e-7;
}
fn surfaceDepthSample(a:f32,b:f32,fraction:f32,maximumJump:f32)->f32{
  if(a<=0. || b<=0. || abs(a-b)>maximumJump+surfaceDepthTolerance(a,b)){return select(a,b,fraction>=.5);}
  return mix(a,b,fraction);
}
fn surfaceConnectedDepth(center:f32,neighbour:f32,maximumJump:f32)->f32{
  return select(0.,neighbour,neighbour>0. && abs(neighbour-center)<=maximumJump+surfaceDepthTolerance(center,neighbour));
}`;

/** Missing depth is not geometry. An unavailable axis uses the normal fallback. */
export const SURFACE_TANGENT_WGSL = `
fn surfaceTangent(center:vec3<f32>,positive:vec3<f32>,negative:vec3<f32>,depths:vec3<f32>)->vec3<f32>{
  let positiveValid=depths.y>0.;let negativeValid=depths.z>0.;
  if(!positiveValid && !negativeValid){return vec3<f32>(0.);}
  if(!positiveValid || (negativeValid && abs(depths.z-depths.x)<abs(depths.y-depths.x))){
    return center-negative;
  }
  return positive-center;
}`;

/** Unit-length tangents make the degeneracy test independent of metres/pixel. */
export const SURFACE_NORMAL_WGSL = `
fn surfaceNormal(dx:vec3<f32>,dy:vec3<f32>,eye:vec3<f32>)->vec3<f32>{
  if(dot(dx,dx)<1e-30 || dot(dy,dy)<1e-30){return eye;}
  let crossNormal=cross(normalize(dx),normalize(dy));
  if(dot(crossNormal,crossNormal)<1e-12){return eye;}
  let n=normalize(crossNormal);return select(n,-n,dot(n,eye)<0.);
}`;

export interface BloodSurfaceOptions {
  /** False selects the original allocation for exact-pixel regression checks. */
  compactStorage?: boolean;
  /** Explicit test harness only. Snapshot copies must be encoded immediately. */
  diagnostics?: (encoder: GPUCommandEncoder, label: string, texture: GPUTexture, channels: 1 | 4) => void;
}
export interface BloodSurfaceProfile {
  pass(label: string): GPURenderPassTimestampWrites | undefined;
}

/**
 * Screen-space fluid surface (Green 2010 / Truong & Yuksel 2018).
 * Accepted-state read only; no smoothing is written back to particle positions.
 * Spectrally derived diffuse-slab optics; synthetic laboratory lighting.
 * This screen-space approximation is not a calibrated surgical-camera model.
 */
export class BloodSurface {
  private depthPipeline: GPURenderPipeline;
  private thicknessPipeline: GPURenderPipeline;
  private particleGroup: GPUBindGroup;
  private filters: GPURenderPipeline[];
  filterMode: "bilateral" | "narrow-range" = "narrow-range";
  private shade: GPURenderPipeline;
  private imageLayout: GPUBindGroupLayout;
  private images: GPUTexture[] = [];
  private groups: GPUBindGroup[] = [];
  private width = 0;
  private height = 0;
  private readonly compactStorage: boolean;
  private readonly thicknessFormat: GPUTextureFormat;
  private readonly diagnostics: BloodSurfaceOptions["diagnostics"];
  private normalPipeline: GPURenderPipeline | undefined;
  private normalTexture: GPUTexture | undefined;
  constructor(private runtime: BloodRuntime, private view: GPUBuffer, private format: GPUTextureFormat, options: BloodSurfaceOptions = {}) {
    this.compactStorage = options.compactStorage ?? true;
    this.diagnostics = options.diagnostics;
    // Only the red channel is consumed. R16Float retains precisely the same
    // channel representation and additive blending as the RGBA16Float reference.
    this.thicknessFormat = this.compactStorage ? "r16float" : "rgba16float";
    const device = runtime.device, s = runtime.scene, n = runtime.count;
    const tray = trayGeometry(s);
    const radius = s.lengthM / s.axis / (s.fixture === "dam" ? 2 : 1) * .9;
    const volumeFactor = 1 / (4 / 3 * Math.PI * .9 ** 3);
    const common = `
      struct View { vp:mat4x4<f32>, right:vec4<f32>, up:vec4<f32>, eye:vec4<f32>, options:vec4<f32> }
      const R=${radius}; const L=${s.lengthM};
    `;
    const particles = device.createShaderModule({ label: "blood/surface depth and thickness", code: common + `
      struct State {p:array<vec4<f32>,${n}>,v:array<vec4<f32>,${n}>}
      @group(0) @binding(0) var<storage,read> A:State;
      @group(0) @binding(1) var<uniform> view:View;
      struct Vertex {@builtin(position) clip:vec4<f32>,@location(0) uv:vec2<f32>,@location(1) center:vec3<f32>}
      @vertex fn vertex(@builtin(vertex_index) vid:u32,@builtin(instance_index) id:u32)->Vertex {
        let corners=array<vec2<f32>,6>(vec2(-1.,-1.),vec2(1.,-1.),vec2(-1.,1.),vec2(-1.,1.),vec2(1.,-1.),vec2(1.,1.));
        var o:Vertex;o.uv=corners[vid];o.center=A.p[id].xyz-vec3<f32>(L*.5);
        o.clip=view.vp*vec4(o.center+R*(o.uv.x*view.right.xyz+o.uv.y*view.up.xyz),1.);return o;
      }
      struct Depth {@location(0) linear:f32,@builtin(frag_depth) depth:f32}
      @fragment fn depth(v:Vertex)->Depth{
        let r2=dot(v.uv,v.uv);if(r2>1.){discard;}
        let p=v.center+R*(v.uv.x*view.right.xyz+v.uv.y*view.up.xyz+sqrt(1.-r2)*normalize(view.eye.xyz));
        let clip=view.vp*vec4(p,1.);var o:Depth;
        o.linear=dot(view.eye.xyz-p,normalize(view.eye.xyz));o.depth=clip.z/clip.w;return o;
      }
      @fragment fn thickness(v:Vertex)->@location(0) vec4<f32>{
        let r2=dot(v.uv,v.uv);if(r2>1.){discard;}
        // Volume-normalized sphere splat; value is metres, not an opacity multiplier.
        return vec4<f32>(2.*R*sqrt(1.-r2)*${volumeFactor});
      }` });
    const particleLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
    ] });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [particleLayout] });
    this.depthPipeline = device.createRenderPipeline({
      layout, vertex: { module: particles, entryPoint: "vertex" }, fragment: { module: particles, entryPoint: "depth", targets: [{ format: "r32float" }] },
      primitive: { topology: "triangle-list" }, depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "less" },
    });
    this.thicknessPipeline = device.createRenderPipeline({
      layout, vertex: { module: particles, entryPoint: "vertex" },
      fragment: { module: particles, entryPoint: "thickness", targets: [{ format: this.thicknessFormat, blend: {
        color: { srcFactor: "one", dstFactor: "one", operation: "add" }, alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
      } }] }, primitive: { topology: "triangle-list" },
    });
    this.particleGroup = device.createBindGroup({ layout: particleLayout, entries: [
      { binding: 0, resource: { buffer: runtime.accepted } }, { binding: 1, resource: { buffer: view } },
    ] });
    const imageShader = device.createShaderModule({ label: "blood/bilateral surface and optical preview", code: common + BLOOD_OPTICS_WGSL + SURFACE_DEPTH_SAMPLE_WGSL + SURFACE_TANGENT_WGSL + SURFACE_NORMAL_WGSL + `
      @group(0) @binding(0) var depth:texture_2d<f32>;
      @group(0) @binding(1) var thick:texture_2d<f32>;
      @group(0) @binding(2) var<uniform> view:View;
      @vertex fn fullscreen(@builtin(vertex_index) id:u32)->@builtin(position) vec4<f32>{
        let p=array<vec2<f32>,3>(vec2(-1.,-1.),vec2(3.,-1.),vec2(-1.,3.));return vec4(p[id],0.,1.);
      }
      fn value(pixel:vec2<i32>)->f32{
        return textureLoad(depth,clamp(pixel,vec2<i32>(0),vec2<i32>(textureDimensions(depth))-1),0).x;
      }
      fn blur(pixel:vec2<i32>,axis:vec2<i32>)->f32{
        let center=value(pixel);if(center==0.){return 0.;}
        // Radius derives from world-space support and projected pixel scale, capped for predictable cost.
        let projected=R*f32(textureDimensions(depth).y)/(2.*tan(0.33161256)*center);
        let radius=clamp(i32(ceil(projected*1.6)),2,32);
        var sum=0.;var weights=0.;
        for(var k=-radius;k<=radius;k++){
          let d=value(pixel+axis*k);if(d==0.){continue;}
          let spatial=f32(k)/max(projected,1.);
          let range=(d-center)/(R*1.4);
          let w=exp(-.5*spatial*spatial-.5*range*range);sum+=d*w;weights+=w;
        }
        return sum/max(weights,1e-8);
      }
      @fragment fn horizontal(@builtin(position) p:vec4<f32>)->@location(0) f32{return blur(vec2<i32>(p.xy),vec2(1,0));}
      @fragment fn vertical(@builtin(position) p:vec4<f32>)->@location(0) f32{return blur(vec2<i32>(p.xy),vec2(0,1));}
      // Truong/Yuksel eqs. 1–9, expressed with positive axial depth.
      // Symmetric pairs prevent a foreground silhouette from biasing the surface
      // behind it. Farther/background values bend the rim instead of flattening it.
      fn along(pixel:vec2<i32>,axis:vec2<i32>,offset:f32)->f32{
        let index=i32(floor(offset));let fraction=fract(offset);
        let a=value(pixel+axis*index);let b=value(pixel+axis*(index+1));
        // Linear interpolation across an occlusion invents in-range samples
        // before the depth-range test can reject the foreground/background.
        return surfaceDepthSample(a,b,fraction,2.*R);
      }
      fn narrow(pixel:vec2<i32>,axis:vec2<i32>)->f32{
        let center=value(pixel);if(center==0.){return 0.;}
        let sigma=max(.7*R*f32(textureDimensions(depth).y)/(2.*tan(.33161256)*center),.5);
        // A local depth jump beyond the rendered support diameter has no
        // overlapping sphere support. Dynamic bounds still follow smooth slopes.
        let delta=2.*R;
        var lowerA=center-delta;var upperA=center+delta;
        var lowerB=center-delta;var upperB=center+delta;
        var sum=center;var weights=1.;
        // Approximately one quadrature node per pixel, with continuous subpixel
        // sampling. A fixed 24-node budget undersampled close-up UHD silhouettes.
        let taps=clamp(i32(ceil(3.*sigma)),4,128);
        for(var k=1;k<=taps;k++){
          let offset=3.*sigma*f32(k)/f32(taps);
          var a=along(pixel,axis,offset);var b=along(pixel,axis,-offset);
          let epsilonA=surfaceDepthTolerance(center,a);let epsilonB=surfaceDepthTolerance(center,b);
          if((a>0. && a<lowerA-epsilonA) || (b>0. && b<lowerB-epsilonB)){continue;}
          let validA=a>0. && a<=upperA+epsilonA;let validB=b>0. && b<=upperB+epsilonB;
          // Follow each connected direction independently. One side of a
          // sloping surface must not widen the other side across an occluder.
          if(validA){lowerA=min(lowerA,a-delta);upperA=max(upperA,a+delta);}
          if(validB){lowerB=min(lowerB,b-delta);upperB=max(upperB,b+delta);}
          a=select(center+R,a,validA);b=select(center+R,b,validB);
          let w=exp(-.5*pow(offset/sigma,2.));
          sum+=(a+b)*w;weights+=2.*w;
        }
        return sum/weights;
      }
      @fragment fn narrowHorizontal(@builtin(position) p:vec4<f32>)->@location(0) f32{return narrow(vec2<i32>(p.xy),vec2(1,0));}
      @fragment fn narrowVertical(@builtin(position) p:vec4<f32>)->@location(0) f32{return narrow(vec2<i32>(p.xy),vec2(0,1));}
      @fragment fn cleanup(@builtin(position) p:vec4<f32>)->@location(0) f32{
        let pixel=vec2<i32>(p.xy);let center=value(pixel);if(center==0.){return 0.;}
        var sum=center;var weights=1.;
        for(var y=-2;y<=2;y++){for(var x=-2;x<=2;x++){
          if(y<0 || (y==0 && x<=0)){continue;}
          let offset=vec2<i32>(x,y);var a=value(pixel+offset);var b=value(pixel-offset);
          if(a==0.){a=L*100.;}if(b==0.){b=L*100.;}
          let epsilonA=surfaceDepthTolerance(center,a);let epsilonB=surfaceDepthTolerance(center,b);
          if(a<center-2.*R-epsilonA || b<center-2.*R-epsilonB){continue;}
          a=select(center+R,a,a<=center+2.*R+epsilonA);b=select(center+R,b,b<=center+2.*R+epsilonB);
          let w=exp(-.5*f32(x*x+y*y));sum+=(a+b)*w;weights+=2.*w;
        }}
        return sum/weights;
      }
      fn world(pixel:vec2<i32>,d:f32)->vec3<f32>{
        let size=vec2<f32>(textureDimensions(depth));let uv=(vec2<f32>(pixel)+.5)/size;
        let back=normalize(view.eye.xyz);let t=tan(0.33161256);
        return view.eye.xyz-back*d+view.right.xyz*((2.*uv.x-1.)*size.x/size.y*t*d)+view.up.xyz*((1.-2.*uv.y)*t*d);
      }
      struct EnvironmentSample { radiance:vec3<f32>,reflectiveFloor:bool }
      fn environmentSample(origin:vec3<f32>,ray:vec3<f32>)->EnvironmentSample{
        // Shared world-space lab environment for the camera and reflected rays.
        // A synthetic diffuse hemisphere, not a measured operating-room HDR map.
        let direction=normalize(ray);
        var background=mix(vec3<f32>(.06,.08,.11),vec3<f32>(.55,.6,.65),clamp(direction.y*.5+.5,0.,1.));
        var reflectiveFloor=false;
        ${s.fixture === "dam" ? `
        // Physical floor location, with a millimetre grid for spatial context.
        // Side walls remain a cutaway; this is a laboratory view, not tissue.
        if(abs(ray.y)>1e-6){
          let t=(${tray.wall - s.lengthM * .5}-origin.y)/ray.y;
          let p=origin+t*ray;
          if(t>0. && abs(p.x)<L*.5-${tray.wall} && abs(p.z)<L*.5-${tray.wall}){
            let grid=abs(fract((p.xz+L*.5)/.001)-.5);
            let line=1.-smoothstep(.46,.49,max(grid.x,grid.y));
            background=mix(vec3<f32>(.25),vec3<f32>(.40),line);
            reflectiveFloor=true;
          }
        }` : ""}
        return EnvironmentSample(background,reflectiveFloor);
      }
      fn environmentRadiance(origin:vec3<f32>,ray:vec3<f32>)->vec3<f32>{
        return environmentSample(origin,ray).radiance;
      }
      fn displayColour(radiance:vec3<f32>)->vec4<f32>{
        return vec4(pow(radiance/(1.+radiance*.3),vec3<f32>(1./2.2)),1.);
      }
      fn reconstructedNormal(pixel:vec2<i32>,d:f32)->vec3<f32>{
        let p=world(pixel,d);
        // A finite value can still belong to an occluding layer. Derivatives
        // must use a local support neighbour, not a vector joining two layers.
        let dr=surfaceConnectedDepth(d,value(pixel+vec2(1,0)),2.*R);
        let dl=surfaceConnectedDepth(d,value(pixel-vec2(1,0)),2.*R);
        let dt=surfaceConnectedDepth(d,value(pixel-vec2(0,1)),2.*R);
        let db=surfaceConnectedDepth(d,value(pixel+vec2(0,1)),2.*R);
        // Cleared neighbours have no world position: world(pixel,0) would
        // otherwise turn the camera position into an artificial surface slope.
        var pr=p;var pl=p;var pt=p;var pb=p;
        if(dr>0.){pr=world(pixel+vec2(1,0),dr);}if(dl>0.){pl=world(pixel-vec2(1,0),dl);}
        if(dt>0.){pt=world(pixel-vec2(0,1),dt);}if(db>0.){pb=world(pixel+vec2(0,1),db);}
        let dx=surfaceTangent(p,pr,pl,vec3(d,dr,dl));
        let dy=surfaceTangent(p,pt,pb,vec3(d,dt,db));
        let eye=normalize(view.eye.xyz-p);
        return surfaceNormal(dx,dy,eye);
      }
      @fragment fn normalDiagnostic(@builtin(position) frag:vec4<f32>)->@location(0) vec4<f32>{
        let pixel=vec2<i32>(frag.xy);let d=value(pixel);
        if(d==0.){return vec4<f32>(0.);}
        return vec4(reconstructedNormal(pixel,d),1.);
      }
      @fragment fn compose(@builtin(position) frag:vec4<f32>)->@location(0) vec4<f32>{
        let pixel=vec2<i32>(frag.xy);
        let d=value(pixel);
        let rear=environmentSample(view.eye.xyz,world(pixel,1.)-view.eye.xyz);
        let background=rear.radiance;
        if(d==0.){return displayColour(background);}
        let thickness=max(textureLoad(thick,pixel,0).x,0.);
        // A zero-thickness layer must reproduce the exact bare-floor/environment
        // display path, including its transfer function and lack of an interface.
        if(!(thickness>0.)){return displayColour(background);}
        let p=world(pixel,d);let eye=normalize(view.eye.xyz-p);
        let normal=reconstructedNormal(pixel,d);
        let light=normalize(view.eye.xyz+view.up.xyz*L*.8-view.right.xyz*L*.5-p);
        let halfVector=normalize(eye+light);
        let nv=max(dot(normal,eye),.001);let nl=max(dot(normal,light),0.);
        let nh=max(dot(normal,halfVector),0.);let vh=max(dot(eye,halfVector),0.);
        let rough=.19;let alpha=rough*rough;let alpha2=alpha*alpha;
        let denominator=nh*nh*(alpha2-1.)+1.;
        let D=alpha2/(3.14159265*denominator*denominator);
        let k=(rough+1.)*(rough+1.)/8.;
        let G=nv/(nv*(1.-k)+k)*nl/(nl*(1.-k)+k);
        let F=.028+.972*pow(1.-vh,5.);
        let specular=min(D*G*F/(4.*nv*max(nl,.001)),5.)*nl;
        let transport=bloodSlabTransport(thickness);
        var body=transport.reflectance*(.35+.65*nl)+background*transport.transmittance;
        if(rear.reflectiveFloor){
          // Known top-lit diffuse floor: light traverses the layer both ways,
          // with approximate repeated slab/substrate reflections. Normalized
          // neutral illumination; no tissue substrate or spatial light transport.
          body=composeDiffuseSubstrate(transport,background);
        }
        let rim=.028+.972*pow(1.-nv,5.);
        let reflected=environmentRadiance(p,reflect(-eye,normal));
        let colour=body*(1.-rim)+reflected*rim+vec3<f32>(specular*.7);
        return displayColour(colour);
      }` });
    this.imageLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
    ] });
    const imagePipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this.imageLayout] });
    const make = (entryPoint: string, target: GPUTextureFormat) => device.createRenderPipeline({
      layout: imagePipelineLayout, vertex: { module: imageShader, entryPoint: "fullscreen" },
      fragment: { module: imageShader, entryPoint, targets: [{ format: target }] }, primitive: { topology: "triangle-list" },
    });
    this.filters = ["horizontal", "vertical", "narrowHorizontal", "narrowVertical", "cleanup"].map(name => make(name, "r32float"));
    this.shade = make("compose", format);
    if (this.diagnostics) this.normalPipeline = make("normalDiagnostic", "rgba32float");
  }
  private resize(width: number, height: number) {
    if (width === this.width && height === this.height) return;
    this.images.forEach(image => image.destroy()); this.normalTexture?.destroy(); this.normalTexture = undefined;
    this.width = width; this.height = height;
    const formats: GPUTextureFormat[] = this.compactStorage
      ? ["r32float", "r32float", this.thicknessFormat, "depth32float"]
      : ["r32float", "r32float", "r32float", this.thicknessFormat, "depth32float"];
    this.images = formats.map(format =>
      this.runtime.device.createTexture({ label: `blood/surface ${format}`, size: [width, height], format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
          | (this.diagnostics && format === "r32float" ? GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST : 0) }));
    if (this.diagnostics) this.normalTexture = this.runtime.device.createTexture({
      label: "blood/test-only normal diagnostic", size: [width, height], format: "rgba32float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const thicknessIndex = this.compactStorage ? 2 : 3;
    this.groups = (this.compactStorage ? [0, 1] : [0, 1, 2]).map(index => this.runtime.device.createBindGroup({ layout: this.imageLayout, entries: [
      { binding: 0, resource: this.images[index]!.createView() }, { binding: 1, resource: this.images[thicknessIndex]!.createView() },
      { binding: 2, resource: { buffer: this.view } },
    ] }));
  }
  private captureDepth(encoder: GPUCommandEncoder, label: string, index: number) {
    if (!this.diagnostics || !this.normalTexture || !this.normalPipeline) return;
    this.diagnostics(encoder, `${label}-depth`, this.images[index]!, 1);
    const pass = encoder.beginRenderPass({ label: `blood/test-only ${label} normals`, colorAttachments: [{
      view: this.normalTexture.createView(), loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 0],
    }] });
    pass.setPipeline(this.normalPipeline); pass.setBindGroup(0, this.groups[index]!); pass.draw(3); pass.end();
    this.diagnostics(encoder, `${label}-normal`, this.normalTexture, 4);
  }
  /** Test-only entry: known analytical depth enters the actual filtering pipeline. */
  encodeDepthFixture(encoder: GPUCommandEncoder, target: GPUTextureView, width: number, height: number, depths: Float32Array) {
    if (!this.diagnostics) throw new Error("Depth fixtures require explicit test diagnostics");
    if (depths.length !== width * height || !depths.every(d => Number.isFinite(d) && d >= 0)) throw new Error("Invalid depth fixture");
    this.resize(width, height);
    this.runtime.device.queue.writeTexture({ texture: this.images[0]! }, depths as Float32Array<ArrayBuffer>,
      { bytesPerRow: width * 4 }, [width, height]);
    const thicknessIndex = this.compactStorage ? 2 : 3;
    const clear = encoder.beginRenderPass({ colorAttachments: [{
      view: this.images[thicknessIndex]!.createView(), clearValue: [.001, .001, .001, .001], loadOp: "clear", storeOp: "store",
    }] }); clear.end();
    this.captureDepth(encoder, "raw", 0);
    this.filterAndCompose(encoder, target);
  }
  encode(encoder: GPUCommandEncoder, target: GPUTextureView, width: number, height: number, profile?: BloodSurfaceProfile) {
    this.resize(width, height);
    const timestamp = (label: string): Pick<GPURenderPassDescriptor, "timestampWrites"> => {
      const writes = profile?.pass(label); return writes ? { timestampWrites: writes } : {};
    };
    const thicknessIndex = this.compactStorage ? 2 : 3, depthIndex = this.compactStorage ? 3 : 4;
    const pass = encoder.beginRenderPass({ label: "blood/surface depth", ...timestamp("surface-depth"), colorAttachments: [{
      view: this.images[0]!.createView(), clearValue: [0, 0, 0, 0], loadOp: "clear", storeOp: "store",
    }], depthStencilAttachment: { view: this.images[depthIndex]!.createView(), depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "discard" } });
    pass.setPipeline(this.depthPipeline); pass.setBindGroup(0, this.particleGroup); pass.draw(6, this.runtime.count); pass.end();
    this.captureDepth(encoder, "raw", 0);
    const thickness = encoder.beginRenderPass({ label: "blood/volume thickness", ...timestamp("surface-thickness"), colorAttachments: [{
      view: this.images[thicknessIndex]!.createView(), clearValue: [0, 0, 0, 0], loadOp: "clear", storeOp: "store",
    }] });
    thickness.setPipeline(this.thicknessPipeline); thickness.setBindGroup(0, this.particleGroup); thickness.draw(6, this.runtime.count); thickness.end();
    this.filterAndCompose(encoder, target, profile);
  }
  private filterAndCompose(encoder: GPUCommandEncoder, target: GPUTextureView, profile?: BloodSurfaceProfile) {
    const timestamp = (label: string): Pick<GPURenderPassDescriptor, "timestampWrites"> => {
      const writes = profile?.pass(label); return writes ? { timestampWrites: writes } : {};
    };
    // Keep the baseline for identical-state visual comparisons. The narrow-range
    // filter uses two separable iterations and a 5x5 cleanup, with bounded taps.
    // After the first pass the initial front-depth image is dead: alternating
    // two textures preserves the complete dependency chain without a third one.
    const stages = this.compactStorage
      ? (this.filterMode === "bilateral" ? [[0, 1, 0], [1, 0, 1]] : [[0, 1, 2], [1, 0, 3], [0, 1, 2], [1, 0, 3], [0, 1, 4]])
      : (this.filterMode === "bilateral" ? [[0, 1, 0], [1, 2, 1]] : [[0, 1, 2], [1, 2, 3], [2, 1, 2], [1, 2, 3], [2, 1, 4]]);
    for (const [stageIndex, [source, destination, pipeline]] of stages.entries()) {
      const filter = encoder.beginRenderPass({ label: `blood/surface ${this.filterMode}`, ...timestamp(`surface-filter-${stageIndex}`), colorAttachments: [{
        view: this.images[destination!]!.createView(), loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 0],
      }] });
      filter.setPipeline(this.filters[pipeline!]!); filter.setBindGroup(0, this.groups[source!]!); filter.draw(3); filter.end();
      this.captureDepth(encoder, `filter-${stageIndex}`, destination!);
    }
    const shade = encoder.beginRenderPass({ label: "blood/optical preview", ...timestamp("surface-compose"), colorAttachments: [{ view: target, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] }] });
    shade.setPipeline(this.shade); shade.setBindGroup(0, this.groups[stages.at(-1)![1]!]!); shade.draw(3); shade.end();
  }
  get renderBytes() { return this.images.length ? this.width * this.height * ((this.compactStorage ? 14 : 24) + (this.normalTexture ? 16 : 0)) : 0; }
  dispose() { this.images.forEach(image => image.destroy()); this.images = []; this.normalTexture?.destroy(); this.normalTexture = undefined; }
}
