import * as THREE from "three";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";

export const LAPAROSCOPE_OPTICS_VERSION = "linear-hdr-wet-glare/1";
const vertexShader = "varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}";
const brightFunction = `vec3 bright(vec3 c){float peak=max(c.r,max(c.g,c.b));float knee=clamp((peak-.8)/.8,0.,1.);return c*(max(peak-1.2,0.)+.2*knee*knee)/max(peak,.0001);}`;

/** Linear HDR scene, half-resolution highlight extraction and separable blur,
 * then a single display transform. The glare redistributes a small fraction of
 * bright radiance; it is an authored PSF approximation, not calibrated optics.
 * No white spots are painted into tissue maps. */
export class LaparoscopeOptics {
  private readonly sceneTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
  private readonly brightTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
  private readonly blurTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
  private readonly finalBlur = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
  private readonly extract = new THREE.ShaderMaterial({ depthTest: false, depthWrite: false, toneMapped: false, vertexShader, uniforms: { image: { value: this.sceneTarget.texture } },
    fragmentShader: `varying vec2 vUv;uniform sampler2D image;${brightFunction}void main(){gl_FragColor=vec4(bright(texture2D(image,vUv).rgb),1.);}` });
  private readonly blur = new THREE.ShaderMaterial({ depthTest: false, depthWrite: false, toneMapped: false, vertexShader, uniforms: { image: { value: this.brightTarget.texture }, stepUv: { value: new THREE.Vector2() } },
    fragmentShader: `varying vec2 vUv;uniform sampler2D image;uniform vec2 stepUv;void main(){vec3 c=texture2D(image,vUv).rgb*.227027;c+=(texture2D(image,vUv+stepUv*1.384615).rgb+texture2D(image,vUv-stepUv*1.384615).rgb)*.316216;c+=(texture2D(image,vUv+stepUv*3.230769).rgb+texture2D(image,vUv-stepUv*3.230769).rgb)*.070270;gl_FragColor=vec4(c,1.);}` });
  private readonly output = new THREE.ShaderMaterial({ depthTest: false, depthWrite: false, vertexShader, uniforms: { image: { value: this.sceneTarget.texture }, glare: { value: this.finalBlur.texture }, strength: { value: .075 } },
    fragmentShader: `varying vec2 vUv;uniform sampler2D image;uniform sampler2D glare;uniform float strength;${brightFunction}void main(){vec4 source=texture2D(image,vUv);gl_FragColor=vec4(max(vec3(0.),source.rgb-strength*bright(source.rgb)+strength*texture2D(glare,vUv).rgb),source.a);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }` });
  private readonly quad = new FullScreenQuad(this.extract);
  private readonly size = new THREE.Vector2();
  private width = 0;
  private height = 0;
  constructor(private renderer: THREE.WebGLRenderer) { this.sceneTarget.samples = Math.min(4, renderer.capabilities.maxSamples); }
  render(scene: THREE.Scene, camera: THREE.Camera) {
    const r = this.renderer; r.getDrawingBufferSize(this.size);
    if (this.width !== this.size.x || this.height !== this.size.y) {
      this.width = this.size.x; this.height = this.size.y;
      this.sceneTarget.setSize(this.width, this.height);
      const w = Math.max(1, Math.ceil(this.width / 2)), h = Math.max(1, Math.ceil(this.height / 2));
      this.brightTarget.setSize(w, h); this.blurTarget.setSize(w, h); this.finalBlur.setSize(w, h);
    }
    r.setRenderTarget(this.sceneTarget); r.render(scene, camera);
    this.quad.material = this.extract; r.setRenderTarget(this.brightTarget); this.quad.render(r);
    this.quad.material = this.blur; this.blur.uniforms.image!.value = this.brightTarget.texture;
    this.blur.uniforms.stepUv!.value.set(1 / this.brightTarget.width, 0); r.setRenderTarget(this.blurTarget); this.quad.render(r);
    this.blur.uniforms.image!.value = this.blurTarget.texture; this.blur.uniforms.stepUv!.value.set(0, 1 / this.brightTarget.height);
    r.setRenderTarget(this.finalBlur); this.quad.render(r);
    this.quad.material = this.output; r.setRenderTarget(null); this.quad.render(r);
  }
  snapshot() { return { version: LAPAROSCOPE_OPTICS_VERSION, hdr: "RGBA16F", samples: this.sceneTarget.samples, glareStrength: this.output.uniforms.strength!.value, glareThreshold: 1.2, glareResolution: [this.brightTarget.width, this.brightTarget.height], outputTransform: "ACES then sRGB, once", calibrated: false }; }
  dispose() { for (const target of [this.sceneTarget, this.brightTarget, this.blurTarget, this.finalBlur]) target.dispose(); for (const material of [this.extract, this.blur, this.output]) material.dispose(); this.quad.dispose(); }
}
