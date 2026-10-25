import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { analyzeCameraRGBD, CameraRGBDSampler, decodeCameraDepth } from "./cameraRGBD";

describe("RGBD camera observations", () => {
  it("decodes metric depth with explicit no-hit and bounded quantization", () => {
    expect(decodeCameraDepth(0, 0, .1, 500)).toBe(0);
    expect(decodeCameraDepth(0, 1, .1, 500)).toBe(.1);
    expect(decodeCameraDepth(255, 255, .1, 500)).toBe(500);
    for (const d of [.1, 20, 60, 120, 499]) {
      const code = 1 + Math.round((d - .1) / (500 - .1) * 65534);
      expect(Math.abs(decodeCameraDepth(Math.floor(code / 256), code % 256, .1, 500) - d)).toBeLessThan(.004);
    }
    expect(() => decodeCameraDepth(1, 2, 0, 500)).toThrow();
  });
  it("uses measured pixels and quantiles; penalizes no geometry, close tissue, darkness and saturated glare", () => {
    const rgb = Array.from({ length: 8 * 6 * 3 }, (_, i) => i % 6 < 3 ? 80 : 160), depth = new Array(48).fill(60);
    const wellExposed = analyzeCameraRGBD(rgb, depth, 8, 6);
    expect(wellExposed.features.depthP10).toBe(60); expect(wellExposed.features.depthMedian).toBe(60);
    expect(wellExposed.features.validDepth).toBe(1); expect(wellExposed.features.contrast).toBeGreaterThan(0);
    expect(wellExposed.quality).toBeGreaterThan(analyzeCameraRGBD(rgb, new Array(48).fill(5), 8, 6).quality);
    expect(wellExposed.quality).toBeGreaterThan(analyzeCameraRGBD(new Array(144).fill(255), depth, 8, 6).quality);
    expect(wellExposed.quality).toBeGreaterThan(analyzeCameraRGBD(new Array(144).fill(0), depth, 8, 6).quality);
    expect(analyzeCameraRGBD(rgb, new Array(48).fill(0), 8, 6).quality).toBe(0);
    expect(() => analyzeCameraRGBD([NaN], depth, 8, 6)).toThrow();
  });
});

function mockRenderer() {
  const initialTarget = new THREE.WebGLRenderTarget(9, 7), initialColor = new THREE.Color(.2, .3, .4);
  const state = { target: initialTarget as THREE.WebGLRenderTarget | null, viewport: new THREE.Vector4(2, 3, 9, 7), scissor: new THREE.Vector4(1, 2, 8, 6), scissorTest: true,
    clearColor: initialColor.clone(), clearAlpha: .7, rendered: 0, failRender: false, deferred: [] as (() => void)[], observed: [] as { scene: THREE.Scene; camera: THREE.Camera }[] };
  const renderer = {
    autoClear: false, toneMapping: THREE.ACESFilmicToneMapping, outputColorSpace: THREE.SRGBColorSpace,
    shadowMap: { enabled: true, autoUpdate: false, needsUpdate: true },
    getRenderTarget: () => state.target, getActiveCubeFace: () => 0, getActiveMipmapLevel: () => 0,
    getViewport: (v: THREE.Vector4) => v.copy(state.viewport), getScissor: (v: THREE.Vector4) => v.copy(state.scissor), getScissorTest: () => state.scissorTest,
    getClearColor: (v: THREE.Color) => v.copy(state.clearColor), getClearAlpha: () => state.clearAlpha,
    setRenderTarget: (v: THREE.WebGLRenderTarget | null) => { state.target = v; },
    setViewport: (x: number | THREE.Vector4, y?: number, width?: number, height?: number) => { if (x instanceof THREE.Vector4) state.viewport.copy(x); else state.viewport.set(x, y!, width!, height!); },
    setScissor: (v: THREE.Vector4) => { state.scissor.copy(v); }, setScissorTest: (v: boolean) => { state.scissorTest = v; },
    setClearColor: (v: THREE.Color | number, a: number) => { state.clearColor.set(v); state.clearAlpha = a; },
    render: (scene: THREE.Scene, camera: THREE.Camera) => { state.observed.push({ scene, camera }); state.rendered++; if (state.failRender && state.rendered === 2) throw new Error("GPU observation failed"); },
    readRenderTargetPixelsAsync: (target: THREE.WebGLRenderTarget, _x: number, _y: number, width: number, height: number, bytes: Uint8Array) => new Promise(resolve => {
      state.deferred.push(() => {
        if (target.texture.colorSpace === THREE.SRGBColorSpace) {
          for (let i = 0; i < width * height; i++) bytes.set([100, 120, 140, 255], 4 * i);
        } else {
          const encoded = 1 + Math.round((60 - .1) / (500 - .1) * 65534);
          for (let y = 16; y < 32; y++) for (let x = 24; x < 40; x++) bytes.set([Math.floor(encoded / 256), encoded % 256, 1, 255], 4 * (y * width + x));
          // A second, large landmark remains outside the central framing area.
          for (let y = 4; y < 44; y++) for (let x = 58; x < 64; x++) bytes.set([Math.floor(encoded / 256), encoded % 256, 2, 255], 4 * (y * width + x));
        }
        resolve(bytes);
      });
    }),
  };
  return { renderer: renderer as unknown as THREE.WebGLRenderer, state, initialTarget, initialColor, raw: renderer };
}

describe("isolated RGBD capture state", () => {
  it("includes unlabelled scene fat as depth ID zero with its world transform, sidedness and layers", async () => {
    const mock = mockRenderer(), scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(46, 2, .1, 500);
    const target = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10), new THREE.MeshBasicMaterial());
    target.position.set(0, 0, -60); scene.add(target);
    const parent = new THREE.Group(); parent.position.set(7, -3, -25); parent.rotation.set(.12, .25, -.07); parent.scale.set(1.2, .8, 1.1); scene.add(parent);
    const fat = new THREE.Mesh(new THREE.PlaneGeometry(25, 25), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    fat.position.set(2, 1, -4); fat.rotation.set(.1, 0, .2); fat.layers.set(2); parent.add(fat); camera.layers.enable(2);
    const marker = new THREE.Mesh(new THREE.SphereGeometry(1), new THREE.MeshBasicMaterial({ depthTest: false, depthWrite: false }));
    const noDepthTest = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({ depthTest: false, depthWrite: true }));
    const noDepthWrite = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({ depthTest: true, depthWrite: false }));
    scene.add(marker, noDepthTest, noDepthWrite);
    const sampler = new CameraRGBDSampler(mock.renderer, scene, [{ id: "target", mesh: target }], [{ id: "target", label: "Target" }]);
    try {
      const pending = sampler.sample(camera); mock.state.deferred.splice(0).forEach(finish => finish()); await pending;
      const pass = mock.state.observed[1]!, proxies = pass.scene.children.filter((child): child is THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> => child instanceof THREE.Mesh);
      const targetProxy = proxies.find(mesh => mesh.geometry === target.geometry), fatProxy = proxies.find(mesh => mesh.geometry === fat.geometry);
      expect(targetProxy).toBeDefined(); expect(fatProxy).toBeDefined(); expect(proxies).toHaveLength(2);
      expect(targetProxy!.material.uniforms.targetId!.value).toBe(1); expect(fatProxy!.material.uniforms.targetId!.value).toBe(0);
      expect(fatProxy!.matrix.elements).toEqual(fat.matrixWorld.elements); expect(fatProxy!.matrixAutoUpdate).toBe(false);
      expect(fatProxy!.material.side).toBe(THREE.DoubleSide); expect(fatProxy!.layers.mask).toBe(fat.layers.mask); expect(pass.camera.layers.mask).toBe(camera.layers.mask);
      expect(proxies.some(mesh => [marker.geometry, noDepthTest.geometry, noDepthWrite.geometry].some(geometry => geometry === mesh.geometry))).toBe(false);
    } finally {
      sampler.dispose(); mock.initialTarget.dispose();
      for (const mesh of [target, fat, marker, noDepthTest, noDepthWrite]) { mesh.geometry.dispose(); mesh.material.dispose(); }
    }
  });

  it("refreshes generated-mesh parent visibility, transform and layers between observations", async () => {
    const mock = mockRenderer(), scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(46, 2, .1, 500);
    const parent = new THREE.Group(), fat = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.MeshBasicMaterial());
    parent.position.set(1, 2, -30); parent.add(fat); scene.add(parent);
    const sampler = new CameraRGBDSampler(mock.renderer, scene, [], [{ id: "target", label: "Target" }]);
    const capture = async () => {
      const pending = sampler.sample(camera); mock.state.deferred.splice(0).forEach(finish => finish()); await pending;
      const pass = mock.state.observed.at(-1)!;
      return pass.scene.children.find(child => child instanceof THREE.Mesh && child.geometry === fat.geometry) as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> | undefined;
    };
    try {
      let proxy = await capture(); expect(proxy).toBeDefined(); expect(proxy!.visible).toBe(true); expect(proxy!.material.uniforms.targetId!.value).toBe(0);
      parent.visible = false; parent.position.x = 9; fat.layers.set(3);
      proxy = await capture(); expect(proxy!.visible).toBe(false); expect(proxy!.matrix.elements).toEqual(fat.matrixWorld.elements); expect(proxy!.layers.mask).toBe(fat.layers.mask);
      parent.visible = true; fat.visible = false; proxy = await capture(); expect(proxy!.visible).toBe(false);
      fat.visible = true; proxy = await capture(); expect(proxy!.visible).toBe(true);
      expect(proxy!.matrix.elements).toEqual(fat.matrixWorld.elements); expect(proxy!.layers.mask).toBe(fat.layers.mask);
    } finally { sampler.dispose(); fat.geometry.dispose(); fat.material.dispose(); mock.initialTarget.dispose(); }
  });

  it("restores the live renderer before async reads finish and derives centered map landmarks from real target pixels", async () => {
    const mock = mockRenderer(), scene = new THREE.Scene(), material = new THREE.MeshBasicMaterial(), source = new THREE.Mesh(new THREE.BoxGeometry(), material), override = new THREE.MeshNormalMaterial();
    scene.add(source); scene.overrideMaterial = override;
    const sampler = new CameraRGBDSampler(mock.renderer, scene, [{ id: "target", mesh: source }], [{ id: "target", label: "Target" }, { id: "edge", label: "Edge target" }]);
    const camera = new THREE.PerspectiveCamera(46, 2, .1, 500), originalProjection = camera.projectionMatrix.clone();
    try {
      const pending = sampler.sample(camera);
      expect(mock.state.target).toBe(mock.initialTarget); expect(mock.state.viewport.toArray()).toEqual([2, 3, 9, 7]);
      expect(mock.state.scissor.toArray()).toEqual([1, 2, 8, 6]); expect(mock.state.scissorTest).toBe(true);
      expect(mock.state.clearColor.equals(mock.initialColor)).toBe(true); expect(mock.state.clearAlpha).toBe(.7);
      expect(mock.raw.toneMapping).toBe(THREE.ACESFilmicToneMapping); expect(mock.raw.outputColorSpace).toBe(THREE.SRGBColorSpace);
      expect(mock.raw.shadowMap).toEqual({ enabled: true, autoUpdate: false, needsUpdate: true }); expect(mock.raw.autoClear).toBe(false);
      expect(scene.overrideMaterial).toBe(override); expect(source.material).toBe(material); expect(camera.projectionMatrix.equals(originalProjection)).toBe(true);
      await expect(sampler.sample(camera)).rejects.toThrow(/current RGBD/);
      mock.state.deferred.forEach(finish => finish());
      const sample = await pending;
      expect(sample.width).toBe(64); expect(sample.height).toBe(48); expect(sample.rgb).toHaveLength(64 * 48 * 3); expect(sample.depth).toHaveLength(64 * 48);
      expect(sample.targetPixels).toEqual([256, 240]); expect(sample.visibleMask).toBe(1); expect(sample.targetCenterErrors[0]).toBeCloseTo(0, 10); expect(sample.targetCenterErrors[1]).toBeGreaterThan(.6);
      expect(sample.features.validDepth).toBeCloseTo(496 / 3072, 10); expect(sample.features.depthMedian).toBeCloseTo(60, 2);
    } finally { sampler.dispose(); source.geometry.dispose(); material.dispose(); override.dispose(); mock.initialTarget.dispose(); }
  });
  it("restores renderer and materials on a failed depth pass and supports abort/disposal", async () => {
    const mock = mockRenderer(), scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(46, 2, .1, 500);
    mock.state.failRender = true;
    const sampler = new CameraRGBDSampler(mock.renderer, scene, [], [{ id: "target", label: "Target" }]);
    try {
      await expect(sampler.sample(camera)).rejects.toThrow(/GPU observation failed/);
      expect(mock.state.target).toBe(mock.initialTarget); expect(mock.state.clearAlpha).toBe(.7); expect(mock.raw.shadowMap.enabled).toBe(true);
      const abort = new AbortController(); abort.abort(); await expect(sampler.sample(camera, abort.signal)).rejects.toMatchObject({ name: "AbortError" });
      sampler.dispose(); await expect(sampler.sample(camera)).rejects.toThrow(/disposed/);
    } finally { sampler.dispose(); mock.initialTarget.dispose(); }
  });
});
