import * as THREE from "three";
import type { RGBDFeatures } from "./cameraRL";

export const CAMERA_OBSERVATION_WIDTH = 64;
export const CAMERA_OBSERVATION_HEIGHT = 48;
export interface CameraRGBDSample {
  features: RGBDFeatures;
  /** Landmarks occupying at least seven pixels with a centroid inside the
   * central 60% of both image axes. Semantic IDs come from the known 3D map. */
  visibleMask: number;
  quality: number;
  /** Top-down, interleaved display RGB bytes; no neural image encoder. */
  rgb: number[];
  /** Top-down linear optical-axis depth in scene millimetres; zero = no hit. */
  depth: number[];
  targetPixels: number[];
  /** Maximum absolute normalized centroid coordinate; Infinity = absent. */
  targetCenterErrors: number[];
  width: number;
  height: number;
}
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const abortError = () => new DOMException("Camera observation capture cancelled.", "AbortError");

/** RG stores 1..65535 for finite linear near..far depth, with zero reserved for
 * background. B stores the privileged map landmark ID (one-based), A coverage.
 * RGBA8 avoids driver-dependent floating-point readback support. */
export function decodeCameraDepth(high: number, low: number, near: number, far: number) {
  if (![high, low, near, far].every(Number.isFinite) || high < 0 || high > 255 || low < 0 || low > 255 || near <= 0 || far <= near) throw new Error("Invalid camera depth encoding.");
  const code = Math.round(high) * 256 + Math.round(low);
  return code <= 0 ? 0 : near + (code - 1) / 65534 * (far - near);
}

/** Pure, testable feature extraction from real RGB and metric depth. Features
 * intentionally remain small and interpretable for browser tabular learning. */
export function analyzeCameraRGBD(rgb: ArrayLike<number>, depth: ArrayLike<number>, width: number, height: number): { features: RGBDFeatures; quality: number } {
  const count = width * height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2 || rgb.length !== count * 3 || depth.length !== count) throw new Error("Invalid RGBD observation dimensions.");
  const luminance = new Float32Array(count), valid: number[] = [];
  let sum = 0, sum2 = 0, glare = 0, dark = 0, near = 0, sharpness = 0;
  for (let i = 0; i < count; i++) {
    const r = rgb[3 * i]! / 255, g = rgb[3 * i + 1]! / 255, b = rgb[3 * i + 2]! / 255, d = depth[i]!;
    if (![r, g, b, d].every(Number.isFinite) || r < 0 || r > 1 || g < 0 || g > 1 || b < 0 || b > 1 || d < 0) throw new Error("RGBD pixels must be finite display bytes and nonnegative metric depth.");
    const l = .2126 * r + .7152 * g + .0722 * b; luminance[i] = l; sum += l; sum2 += l * l;
    if (Math.max(r, g, b) > .98 && Math.min(r, g, b) > .86) glare++;
    if (l < .08) dark++;
    if (d > 0) { valid.push(d); if (d < 20) near++; }
  }
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const i = y * width + x;
    sharpness += Math.abs(4 * luminance[i]! - luminance[i - 1]! - luminance[i + 1]! - luminance[i - width]! - luminance[i + width]!);
  }
  valid.sort((a, b) => a - b);
  const quantile = (p: number) => valid.length ? valid[Math.floor((valid.length - 1) * p)]! : 0;
  const mean = sum / count;
  const features: RGBDFeatures = {
    luminance: mean, contrast: Math.sqrt(Math.max(0, sum2 / count - mean ** 2)), glare: glare / count, dark: dark / count,
    depthP10: quantile(.1), depthMedian: quantile(.5), depthP90: quantile(.9), validDepth: valid.length / count,
    nearFraction: valid.length ? near / valid.length : 0, sharpness: sharpness / ((width - 2) * (height - 2) * 4),
  };
  const exposure = clamp(1 - Math.abs(mean - .48) / .48), workingDistance = clamp(1 - Math.abs(features.depthMedian - 60) / 100);
  const quality = valid.length ? clamp(.22 * exposure + .12 * clamp(features.contrast / .16) + .08 * clamp(features.sharpness / .15)
    + .28 * clamp(features.validDepth / .55) + .30 * workingDistance - .30 * features.glare - .35 * features.nearFraction - .10 * features.dark) : 0;
  return { features, quality };
}

function hierarchyVisible(object: THREE.Object3D) {
  for (let node: THREE.Object3D | null = object; node; node = node.parent) if (!node.visible) return false;
  return true;
}

/** Captures actual shaded scene RGB plus a separate depth/map-ID proxy pass.
 * Proxy meshes share current geometry but never modify source materials. The
 * parent supplies camera-mounted illumination and restores it after sampling.
 * The RGB pass precedes authored HDR glare postprocessing; it is not a copy of
 * the final display framebuffer or an inferred segmentation model. */
export class CameraRGBDSampler {
  private readonly rgbTarget = new THREE.WebGLRenderTarget(CAMERA_OBSERVATION_WIDTH, CAMERA_OBSERVATION_HEIGHT, { type: THREE.UnsignedByteType, depthBuffer: true });
  private readonly depthTarget = new THREE.WebGLRenderTarget(CAMERA_OBSERVATION_WIDTH, CAMERA_OBSERVATION_HEIGHT, { type: THREE.UnsignedByteType, depthBuffer: true });
  private readonly proxy = new THREE.Scene();
  private readonly proxyMeshes: { source: THREE.Mesh; mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> }[] = [];
  private disposed = false;
  private busy = false;
  constructor(private readonly renderer: THREE.WebGLRenderer, private readonly scene: THREE.Scene,
    surfaces: { id: string; mesh: THREE.Mesh }[], private readonly targets: { id: string; label: string }[]) {
    if (targets.length > 6 || new Set(targets.map(target => target.id)).size !== targets.length) throw new Error("Camera observations support up to six distinct landmarks.");
    this.rgbTarget.texture.colorSpace = THREE.SRGBColorSpace;
    this.depthTarget.texture.colorSpace = THREE.NoColorSpace;
    for (const surface of surfaces) {
      const id = targets.findIndex(target => target.id === surface.id) + 1;
      const material = new THREE.ShaderMaterial({
        side: Array.isArray(surface.mesh.material) ? surface.mesh.material[0]?.side ?? THREE.DoubleSide : surface.mesh.material.side,
        depthTest: true, depthWrite: true, blending: THREE.NoBlending, toneMapped: false,
        uniforms: { cameraNear: { value: .1 }, cameraFar: { value: 4000 }, targetId: { value: id } },
        vertexShader: "varying float metricDepth; void main(){vec4 viewPosition=modelViewMatrix*vec4(position,1.);metricDepth=-viewPosition.z;gl_Position=projectionMatrix*viewPosition;}",
        fragmentShader: "varying float metricDepth;uniform float cameraNear;uniform float cameraFar;uniform float targetId;void main(){float normalizedDepth=clamp((metricDepth-cameraNear)/(cameraFar-cameraNear),0.,1.);float encoded=1.+floor(normalizedDepth*65534.+.5);gl_FragColor=vec4(floor(encoded/256.)/255.,mod(encoded,256.)/255.,targetId/255.,1.);}",
      });
      const mesh = new THREE.Mesh(surface.mesh.geometry, material); mesh.matrixAutoUpdate = false; mesh.frustumCulled = false;
      this.proxy.add(mesh); this.proxyMeshes.push({ source: surface.mesh, mesh });
    }
  }
  async sample(camera: THREE.PerspectiveCamera, signal?: AbortSignal): Promise<CameraRGBDSample> {
    if (this.disposed) throw new Error("The RGBD sampler has been disposed.");
    if (this.busy) throw new Error("Wait for the current RGBD observation before requesting another.");
    if (signal?.aborted) throw abortError();
    if (![camera.near, camera.far, camera.fov, ...camera.position.toArray(), ...camera.quaternion.toArray()].every(Number.isFinite) || camera.near <= 0 || camera.far <= camera.near || camera.fov <= 0 || camera.fov >= 179) throw new Error("Invalid RGBD camera.");
    this.busy = true;
    try {
      const width = CAMERA_OBSERVATION_WIDTH, height = CAMERA_OBSERVATION_HEIGHT, count = width * height;
      const rgbBytes = new Uint8Array(count * 4), depthBytes = new Uint8Array(count * 4);
      camera.updateWorldMatrix(true, false);
      const capture = camera.clone(); camera.getWorldPosition(capture.position); camera.getWorldQuaternion(capture.quaternion);
      capture.aspect = width / height; capture.updateProjectionMatrix(); capture.updateMatrixWorld(true);
      this.scene.updateMatrixWorld(true);
      for (const { source, mesh } of this.proxyMeshes) {
        mesh.geometry = source.geometry; mesh.visible = hierarchyVisible(source); mesh.matrix.copy(source.matrixWorld);
        mesh.material.uniforms.cameraNear!.value = capture.near; mesh.material.uniforms.cameraFar!.value = capture.far;
      }
      const r = this.renderer;
      const saved = { target: r.getRenderTarget(), face: r.getActiveCubeFace(), mip: r.getActiveMipmapLevel(), viewport: r.getViewport(new THREE.Vector4()),
        scissor: r.getScissor(new THREE.Vector4()), scissorTest: r.getScissorTest(), clearColor: r.getClearColor(new THREE.Color()), clearAlpha: r.getClearAlpha(),
        toneMapping: r.toneMapping, outputColorSpace: r.outputColorSpace, override: this.scene.overrideMaterial,
        shadowAuto: r.shadowMap.autoUpdate, shadowEnabled: r.shadowMap.enabled, shadowNeedsUpdate: r.shadowMap.needsUpdate, autoClear: r.autoClear };
      const reads: Promise<unknown>[] = [];
      let captureError: unknown;
      try {
        r.autoClear = true; r.setScissorTest(false); this.scene.overrideMaterial = null;
        r.outputColorSpace = THREE.SRGBColorSpace; r.setRenderTarget(this.rgbTarget); r.setViewport(0, 0, width, height); r.render(this.scene, capture);
        r.toneMapping = THREE.NoToneMapping; r.outputColorSpace = THREE.LinearSRGBColorSpace;
        r.shadowMap.enabled = false; r.setClearColor(0x000000, 0); r.setRenderTarget(this.depthTarget); r.setViewport(0, 0, width, height); r.render(this.proxy, capture);
        // Three enqueues a PBO read, restores its framebuffer synchronously,
        // and only waits for a GPU fence. Restore user state before awaiting;
        // animation remains free to render while the observations finish.
        if (typeof r.readRenderTargetPixelsAsync === "function") {
          reads.push(r.readRenderTargetPixelsAsync(this.rgbTarget, 0, 0, width, height, rgbBytes));
          reads.push(r.readRenderTargetPixelsAsync(this.depthTarget, 0, 0, width, height, depthBytes));
        } else {
          r.readRenderTargetPixels(this.rgbTarget, 0, 0, width, height, rgbBytes); r.readRenderTargetPixels(this.depthTarget, 0, 0, width, height, depthBytes);
        }
      } catch (error) {
        captureError = error;
      } finally {
        this.scene.overrideMaterial = saved.override; r.autoClear = saved.autoClear; r.toneMapping = saved.toneMapping; r.outputColorSpace = saved.outputColorSpace;
        r.shadowMap.enabled = saved.shadowEnabled; r.shadowMap.autoUpdate = saved.shadowAuto; r.shadowMap.needsUpdate = saved.shadowNeedsUpdate;
        r.setClearColor(saved.clearColor, saved.clearAlpha); r.setRenderTarget(saved.target, saved.face, saved.mip);
        r.setViewport(saved.viewport); r.setScissor(saved.scissor); r.setScissorTest(saved.scissorTest);
      }
      const readResults = await Promise.allSettled(reads);
      if (captureError !== undefined) throw captureError;
      const failed = readResults.find(result => result.status === "rejected"); if (failed?.status === "rejected") throw failed.reason;
      if (signal?.aborted || this.disposed) throw abortError();
      const rgb = new Array<number>(count * 3), depth = new Array<number>(count), targetPixels = this.targets.map(() => 0), xSum = this.targets.map(() => 0), ySum = this.targets.map(() => 0);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const i = y * width + x, source = (height - 1 - y) * width + x, offset = source * 4;
        rgb[3 * i] = rgbBytes[offset]!; rgb[3 * i + 1] = rgbBytes[offset + 1]!; rgb[3 * i + 2] = rgbBytes[offset + 2]!;
        depth[i] = decodeCameraDepth(depthBytes[offset]!, depthBytes[offset + 1]!, capture.near, capture.far);
        const id = depthBytes[offset + 2]! - 1;
        if (depth[i]! > 0 && id >= 0 && id < this.targets.length) { targetPixels[id]!++; xSum[id]! += x + .5; ySum[id]! += y + .5; }
      }
      let visibleMask = 0;
      const targetCenterErrors = targetPixels.map((pixels, i) => pixels ? Math.max(Math.abs(2 * xSum[i]! / pixels / width - 1), Math.abs(2 * ySum[i]! / pixels / height - 1)) : Infinity);
      targetPixels.forEach((pixels, i) => { if (pixels >= 7 && targetCenterErrors[i]! < .6) visibleMask |= 1 << i; });
      return { ...analyzeCameraRGBD(rgb, depth, width, height), visibleMask, rgb, depth, targetPixels, targetCenterErrors, width, height };
    } finally {
      this.busy = false; if (this.disposed) this.release();
    }
  }
  private release() { this.rgbTarget.dispose(); this.depthTarget.dispose(); for (const { mesh } of this.proxyMeshes) mesh.material.dispose(); this.proxy.clear(); }
  dispose() { if (this.disposed) return; this.disposed = true; if (!this.busy) this.release(); }
}
