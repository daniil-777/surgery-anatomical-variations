/// <reference types="@webgpu/types" />
/** Explicit GPU diagnostics; never imported by the application. */
import { Matrix4, PerspectiveCamera, Vector3 } from "three";
import { BloodRuntime } from "./runtime";
import { BloodSurface } from "./surface";
import { DEFAULT_SCENE, type BloodScene } from "./scene";

interface DiagnosticOptions {
  scene?: Partial<BloodScene>;
  state?: number[];
  orbit?: number;
  compactStorage?: boolean;
  width?: number;
  height?: number;
  depths?: number[];
  includeRaw?: boolean;
}
const hash = async (bytes: ArrayBuffer) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
  .map(v => v.toString(16).padStart(2, "0")).join("");
function base64(bytes: Uint8Array) {
  let text = "";
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
}
function png(width: number, height: number, pixels: Uint8ClampedArray<ArrayBuffer>) {
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
  canvas.getContext("2d")!.putImageData(new ImageData(pixels, width, height), 0, 0);
  return canvas.toDataURL("image/png");
}

/** Captures raw + every filtered depth and actual reconstructed normal at fixed state. */
export async function surfaceDiagnosticBench(options: DiagnosticOptions = {}) {
  const width = options.width ?? 1280, height = options.height ?? 720, orbit = options.orbit ?? 0;
  if (![width, height].every(v => Number.isInteger(v) && v >= 16 && v <= 4096)) throw new Error("Invalid diagnostic size");
  const r = await BloodRuntime.create({ ...DEFAULT_SCENE, ...options.scene });
  const captures: { label: string; buffer: GPUBuffer; channels: 1 | 4; stride: number }[] = [];
  let surface: BloodSurface | undefined, uniform: GPUBuffer | undefined, target: GPUTexture | undefined;
  try {
    const device = r.device, distance = r.scene.lengthM * 2.7, yaw = .65 + orbit * .1, pitch = .4;
    const camera = new PerspectiveCamera(38, width / height,
      Math.max(r.scene.lengthM * .05, distance - r.scene.lengthM * 1.1), distance + r.scene.lengthM * 1.1);
    camera.position.set(Math.sin(yaw) * Math.cos(pitch) * distance, Math.sin(pitch) * distance, Math.cos(yaw) * Math.cos(pitch) * distance);
    camera.lookAt(0, 0, 0); camera.updateMatrixWorld(); camera.updateProjectionMatrix();
    const remap = new Matrix4().set(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, .5, .5, 0, 0, 0, 1);
    const data = new Float32Array(32);
    data.set(remap.multiply(camera.projectionMatrix).multiply(camera.matrixWorldInverse).elements);
    data.set(new Vector3().setFromMatrixColumn(camera.matrixWorld, 0).toArray(), 16);
    data.set(new Vector3().setFromMatrixColumn(camera.matrixWorld, 1).toArray(), 20);
    data.set(camera.position.toArray(), 24);
    uniform = device.createBuffer({ size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(uniform, 0, data);
    const capture = (encoder: GPUCommandEncoder, label: string, texture: GPUTexture, channels: 1 | 4) => {
      const stride = Math.ceil(width * channels * 4 / 256) * 256;
      const buffer = device.createBuffer({ label: `blood/test-only ${label} readback`, size: stride * height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
      captures.push({ label, buffer, channels, stride });
      encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: stride }, [width, height]);
    };
    surface = new BloodSurface(r, uniform, "rgba8unorm", { compactStorage: options.compactStorage ?? true, diagnostics: capture });
    target = device.createTexture({ size: [width, height], format: "rgba8unorm",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    if (options.state) {
      const state = new Float32Array(options.state);
      if (state.byteLength !== r.accepted.size || !state.every(Number.isFinite)) throw new Error("Invalid frozen accepted state");
      device.queue.writeBuffer(r.accepted, 0, state);
    }
    const before = await hash(await r.readBuffer(r.accepted)), encoder = device.createCommandEncoder();
    if (options.depths) surface.encodeDepthFixture(encoder, target.createView(), width, height, new Float32Array(options.depths));
    else surface.encode(encoder, target.createView(), width, height);
    const pixelStride = Math.ceil(width * 4 / 256) * 256;
    const pixelsBuffer = device.createBuffer({ size: pixelStride * height, usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    captures.push({ label: "colour", buffer: pixelsBuffer, channels: 1, stride: pixelStride });
    encoder.copyTextureToBuffer({ texture: target }, { buffer: pixelsBuffer, bytesPerRow: pixelStride }, [width, height]);
    device.queue.submit([encoder.finish()]);
    const snapshots = [];
    let image = "";
    for (const capture of captures) {
      const bytes = new Uint8Array(await r.readBuffer(capture.buffer)), packed = new Uint8Array(width * height * capture.channels * 4);
      for (let y = 0; y < height; ++y) packed.set(bytes.subarray(y * capture.stride, y * capture.stride + width * capture.channels * 4), y * width * capture.channels * 4);
      if (capture.label === "colour") { image = png(width, height, new Uint8ClampedArray(packed.buffer)); continue; }
      const values = new Float32Array(packed.buffer), rgba = new Uint8ClampedArray(width * height * 4);
      let finite = true, count = 0, minimum = Infinity, maximum = -Infinity;
      for (let i = 0; i < width * height; ++i) {
        const valid = capture.channels === 1 ? values[i]! > 0 : values[i * 4 + 3]! > 0;
        for (let k = 0; k < capture.channels; ++k) finite &&= Number.isFinite(values[i * capture.channels + k]!);
        if (valid) { count++; minimum = Math.min(minimum, values[i * capture.channels]!); maximum = Math.max(maximum, values[i * capture.channels]!); }
        if (capture.channels === 1) {
          // Fixed camera-depth scale across passes, not an independently stretched image.
          const shade = valid ? Math.round(255 * (values[i]! - r.scene.lengthM * 1.5) / (r.scene.lengthM * 2.5)) : 0;
          rgba.set([shade, shade, shade, 255], i * 4);
        } else rgba.set(valid ? [255 * (.5 + values[i * 4]! / 2), 255 * (.5 + values[i * 4 + 1]! / 2), 255 * (.5 + values[i * 4 + 2]! / 2), 255] : [0, 0, 0, 255], i * 4);
      }
      snapshots.push({ label: capture.label, channels: capture.channels, finite, count,
        minimum: count ? minimum : null, maximum: count ? maximum : null, hash: await hash(packed.buffer),
        image: png(width, height, rgba), ...(options.includeRaw ? { rawFloat32Base64: base64(packed) } : {}) });
    }
    const after = await hash(await r.readBuffer(r.accepted));
    return { status: before === after && snapshots.every(s => s.finite) && !r.errors.length ? "PASS" : "FAIL",
      width, height, orbit, compactStorage: options.compactStorage ?? true, config: r.scene, stateHash: after,
      stateUnchanged: before === after, errors: r.errors, image, snapshots,
      limitation: "Frozen accepted-state reconstruction diagnostics. No simulation or clinical realism validation." };
  } finally { captures.forEach(c => c.buffer.destroy()); target?.destroy(); surface?.dispose(); uniform?.destroy(); r.dispose(); }
}

/** Independent signal/occlusion invariants through the complete GPU filter chain. */
export async function surfaceReconstructionBench() {
  const width = 128, height = 128, middle = width / 2;
  const cases: { name: string; field: (x: number, y: number) => number; background?: (x: number, y: number) => boolean; tolerance?: number }[] = [
    { name: "constant-plane", field: () => .06, background: () => true, tolerance: 1e-7 },
    { name: "grazing-affine-depth-ramp", field: (x, y) => .16 + (x - middle) * .0009 + (y - middle) * .0006,
      background: (x, y) => x >= 20 && x < 108 && y >= 20 && y < 108, tolerance: 5e-7 },
    { name: "isolated-pixel", field: (x, y) => x === middle && y === middle ? .03 : 0 },
    { name: "one-pixel-filament", field: x => x === middle ? .03 : 0 },
    { name: "foreground-filament-over-flat-background", field: x => x === middle ? .03 : .06,
      background: x => x !== middle, tolerance: 1e-7 },
    { name: "close-separated-layers", field: (x, y) => x >= 45 && x <= 83 && y >= 45 && y <= 83 ? .03 : .0345,
      background: (x, y) => x < 45 || x > 83 || y < 45 || y > 83, tolerance: 1e-7 },
    { name: "inclined-background-and-occluder", field: (x, y) => x >= 45 && x <= 83 && y >= 45 && y <= 83 ? .03 : .06 + (x - middle) * .0002,
      background: (x, y) => x >= 20 && x < 108 && y >= 20 && y < 108 && (x < 45 || x > 83 || y < 45 || y > 83), tolerance: 2e-6 },
  ];
  const samples = [];
  const decode = (encoded: string) => Float32Array.from(new Float32Array(Uint8Array.from(atob(encoded), c => c.charCodeAt(0)).buffer));
  for (const fixture of cases) {
    const depths = Array.from({ length: width * height }, (_, i) => fixture.field(i % width, Math.floor(i / width)));
    const result = await surfaceDiagnosticBench({ width, height, scene: { fixture: "dam" }, depths, includeRaw: true });
    const final = decode(result.snapshots.find(s => s.label === "filter-4-depth")!.rawFloat32Base64!);
    const normals = decode(result.snapshots.find(s => s.label === "filter-4-normal")!.rawFloat32Base64!);
    let maskMismatches = 0, maximumBackgroundErrorM = 0, finiteNormals = true, maximumNormalLengthError = 0;
    for (let i = 0; i < depths.length; ++i) {
      if ((depths[i]! > 0) !== (final[i]! > 0)) maskMismatches++;
      if (fixture.background?.(i % width, Math.floor(i / width))) maximumBackgroundErrorM = Math.max(maximumBackgroundErrorM, Math.abs(final[i]! - Math.fround(depths[i]!)));
      if (depths[i]! > 0) {
        const xyz = Array.from(normals.slice(i * 4, i * 4 + 3));
        finiteNormals &&= xyz.every(Number.isFinite);
        maximumNormalLengthError = Math.max(maximumNormalLengthError, Math.abs(Math.hypot(...xyz) - 1));
      }
    }
    let unavailableAxisFallbackError = 0;
    if (fixture.name.includes("filament") || fixture.name === "isolated-pixel") {
      const yaw = .65, pitch = .4;
      const back = new Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
      const right = new Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
      const up = new Vector3().crossVectors(back, right);
      const expected = back.clone().addScaledVector(right, -(2 * (middle + .5) / width - 1) * Math.tan(19 * Math.PI / 180))
        .addScaledVector(up, -(1 - 2 * (middle + .5) / height) * Math.tan(19 * Math.PI / 180)).normalize();
      const index = (middle * width + middle) * 4;
      unavailableAxisFallbackError = Math.hypot(normals[index]! - expected.x, normals[index + 1]! - expected.y, normals[index + 2]! - expected.z);
    }
    const passed = result.status === "PASS" && maskMismatches === 0 && finiteNormals && maximumNormalLengthError < 1e-5
      && maximumBackgroundErrorM <= (fixture.tolerance ?? Infinity) && unavailableAxisFallbackError < 1e-5;
    samples.push({ name: fixture.name, passed, maskMismatches, maximumBackgroundErrorM, toleranceM: fixture.tolerance ?? null,
      maximumNormalLengthError, unavailableAxisFallbackError, stateUnchanged: result.stateUnchanged, errors: result.errors });
  }
  return { gate: "surface-reconstruction-discontinuities", status: samples.every(s => s.passed) ? "PASS" : "FAIL", samples,
    limitation: "Analytical signals and layer separation, not a clinical-realism or arbitrary-topology proof. An affine axial-depth ramp is not a perspective planar surface." };
}
