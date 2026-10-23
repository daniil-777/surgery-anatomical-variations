/** Explicit development-only renderer gate. Never imported by product routes.
 * Real pointer/touch and encoded video checks live in the independent UI runner.
 */
import { getSceneRecordingSource } from "../../sceneRecordingSource";
import { ACESFilmicToneMapping, BufferAttribute, BufferGeometry, Color, DataTexture, DirectionalLight, FloatType,
  Material, Mesh, MeshPhysicalMaterial, NearestFilter, NoToneMapping, OrthographicCamera,
  PlaneGeometry, RectAreaLight, RGBAFormat, Scene, ShaderMaterial, SRGBColorSpace, WebGLRenderer, WebGLRenderTarget } from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { loadLiverAnatomy } from "./anatomy";
import { LiverFlowExperiment } from "./liverFlow";
import { installLiverFilmOptics, LIVER_FILM_FRAGMENT_OPTICS, LiverRenderer, liverFilmInterfaceRoughness,
  liverFilmLevelingFactor, liverFilmOpticalRGBA, liverFilmTransportTextureData } from "./renderer";
import { initializeLiverAreaLightUniforms, LIVER_OPERATING_PANEL, rectangularEmitterProjectedSolidAngle } from "./renderer";
import { APPEARANCE_THICKNESS_COUNT } from "../experiments/bloodAppearanceLut.generated";
import { prepareLiverCut } from "./wounds";
import { runoffAttachedGeometry } from "./runoff";
import type { LiverAnatomy } from "./types";

type Check = { name: string; passed: boolean; details?: unknown };
const frames = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
const snapshot = (value: unknown) => JSON.stringify(value, (_key, item: unknown) =>
  ArrayBuffer.isView(item) ? Array.from(item as unknown as ArrayLike<number>) : item);
const event = (target: EventTarget, type: string) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${type} timed out`)), 3000);
  target.addEventListener(type, () => { clearTimeout(timer); resolve(); }, { once: true });
});
/** Independent radiometry gate for the actual engine's finite-area diffuse
 * path. Analytic irradiance is E=L∫cosθi cosθe/r² dA, rather than a guessed
 * image brightness. Extraction avoids tone mapping and specular partition.
 */
function operatingEmitterOracle() {
  initializeLiverAreaLightUniforms();
  const gpu = new WebGLRenderer({ antialias: false });
  const target = new WebGLRenderTarget(1, 1, { type: FloatType, format: RGBAFormat, depthBuffer: false });
  const geometry = new PlaneGeometry(10, 10), material = new MeshPhysicalMaterial({
    color: new Color().setRGB(.18, .18, .18), roughness: .5, metalness: 0, specularIntensity: 0,
  });
  material.onBeforeCompile = shader => {
    shader.fragmentShader = shader.fragmentShader.replace("#include <opaque_fragment>",
      "gl_FragColor = vec4(reflectedLight.directDiffuse, 1.0);");
  };
  const scene = new Scene(); scene.add(new Mesh(geometry, material));
  const light = new RectAreaLight(0xffffff, 1, 1, 1); scene.add(light);
  const camera = new OrthographicCamera(-5, 5, 5, -5, 1, 5000);
  camera.position.set(0, 100, 1000); camera.lookAt(0, 0, 0);
  const pixels = new Float32Array(4), samples: unknown[] = [];
  let maximumRelativeError = 0;
  try {
    gpu.toneMapping = NoToneMapping; gpu.setSize(1, 1); gpu.setRenderTarget(target);
    for (const [widthM, heightM, distanceM] of [[.4, .3, .6], [.1, .1, .3]]) {
      const projected = rectangularEmitterProjectedSolidAngle(widthM!, heightM!, distanceM!);
      const irradiance = LIVER_OPERATING_PANEL.referenceRelativeIrradiance;
      light.width = widthM! * 1000; light.height = heightM! * 1000;
      light.position.set(0, 0, distanceM! * 1000); light.lookAt(0, 0, 0);
      light.intensity = irradiance / projected;
      gpu.render(scene, camera); gpu.readRenderTargetPixels(target, 0, 0, 1, 1, pixels);
      const expected = .18 * irradiance / Math.PI;
      for (let channel = 0; channel < 3; channel++) {
        if (!Number.isFinite(pixels[channel])) throw new Error("Nonfinite native area-light response");
        maximumRelativeError = Math.max(maximumRelativeError, Math.abs(pixels[channel]! / expected - 1));
      }
      samples.push({ widthM, heightM, distanceM, projectedSolidAngle: projected, relativeRadiance: light.intensity,
        expectedLinearDiffuse: expected, actualLinearDiffuse: Array.from(pixels.slice(0, 3)) });
    }
    return { passed: maximumRelativeError < 5e-4, maximumRelativeError, tolerance: 5e-4, samples,
      limitations: "LTC finite-area approximation without shadows; relative radiometric units, not lux calibration" };
  } finally {
    geometry.dispose(); material.dispose(); target.dispose(); gpu.dispose(); gpu.forceContextLoss();
  }
}
/** Native shader arithmetic, not a guessed image-colour threshold. The
 * triangle interpolates physical h; the fragment shader is the product code.
 * Expected R/T/composition comes from the independently tested CPU model.
 */
function fragmentOpticsOracle() {
  const width = 33, gpu = new WebGLRenderer({ antialias: false });
  const target = new WebGLRenderTarget(width, 1, { type: FloatType, format: RGBAFormat, depthBuffer: false });
  const texture = new DataTexture(liverFilmTransportTextureData(.75), APPEARANCE_THICKNESS_COUNT, 2, RGBAFormat, FloatType);
  texture.magFilter = texture.minFilter = NearestFilter; texture.generateMipmaps = false; texture.needsUpdate = true;
  const geometry = new PlaneGeometry(2, 2), h = new Float32Array([0, .0005, 0, .0005]);
  geometry.setAttribute("oracleThickness", new BufferAttribute(h, 1));
  const material = new ShaderMaterial({
    uniforms: { uLiverFilmTransport: { value: texture } },
    vertexShader: `attribute float oracleThickness; varying float filmH;
void main() { filmH = oracleThickness; gl_Position = vec4(position, 1.0); }`,
    fragmentShader: `varying float filmH; ${LIVER_FILM_FRAGMENT_OPTICS}
void main() { gl_FragColor = liverFilmOpticalLayer(filmH, vec3(0.18, 0.04, 0.025)); }`,
    toneMapped: false,
  });
  const scene = new Scene(); scene.add(new Mesh(geometry, material));
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 2), pixels = new Float32Array(width * 4);
  let maxAbsoluteError = 0, testedFragments = 0;
  try {
    gpu.setSize(width, 1); gpu.setRenderTarget(target);
    for (const saturation of [0, .75, .983, 1]) {
      liverFilmTransportTextureData(saturation, texture.image.data as Float32Array); texture.needsUpdate = true;
      gpu.render(scene, camera); gpu.readRenderTargetPixels(target, 0, 0, width, 1, pixels);
      for (let i = 0; i < width; i++) {
        const expected = liverFilmOpticalRGBA((i + .5) / width * .0005, saturation, [.18, .04, .025]);
        for (let channel = 0; channel < 4; channel++) {
          const value = pixels[i * 4 + channel]!;
          if (!Number.isFinite(value)) throw new Error("Nonfinite native film optical response");
          maxAbsoluteError = Math.max(maxAbsoluteError, Math.abs(value - expected[channel]!));
        }
        testedFragments++;
      }
      if (saturation === .75 && pixels[16 * 4 + 3]! < .999)
        throw new Error("Wet/dry midpoint used interpolated alpha instead of its physical 0.25mm thickness");
    }
    h.fill(0); geometry.getAttribute("oracleThickness").needsUpdate = true;
    gpu.render(scene, camera); gpu.readRenderTargetPixels(target, 0, 0, width, 1, pixels);
    const dryExactlyAbsent = pixels.every(value => value === 0);
    return { passed: dryExactlyAbsent && maxAbsoluteError < 3e-5, testedFragments,
      maxAbsoluteError, tolerance: 3e-5, dryExactlyAbsent };
  } finally {
    geometry.dispose(); material.dispose(); texture.dispose(); target.dispose();
    gpu.dispose(); gpu.forceContextLoss();
  }
}
/** Actual MeshPhysicalMaterial, linear HDR render target AND final ACES/sRGB
 * framebuffer. CPU-composed reference material must give the same pixels, and
 * changing slab thickness must not alpha-fade the dielectric interface.
 */
function shadedOpticsOracle() {
  const gpu = new WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
  gpu.setSize(32, 32); gpu.outputColorSpace = SRGBColorSpace;
  const target = new WebGLRenderTarget(32, 32, { type: FloatType, format: RGBAFormat });
  const texture = new DataTexture(liverFilmTransportTextureData(.75), APPEARANCE_THICKNESS_COUNT, 2, RGBAFormat, FloatType);
  texture.minFilter = texture.magFilter = NearestFilter; texture.generateMipmaps = false; texture.needsUpdate = true;
  const geometry = new PlaneGeometry(2, 2), backGeometry = new PlaneGeometry(2, 2), thickness = new Float32Array(4);
  const capsuleNormal = [.12, 0, Math.sqrt(1 - .12 ** 2)], expectedNormal = [0, 0, 1];
  geometry.setAttribute("liverThicknessM", new BufferAttribute(thickness, 1));
  geometry.setAttribute("liverSubstrateLinear", new BufferAttribute(new Float32Array([
    .18, .04, .025, .18, .04, .025, .18, .04, .025, .18, .04, .025,
  ]), 3));
  geometry.setAttribute("liverCapsuleNormal", new BufferAttribute(Float32Array.from([
    ...capsuleNormal, ...capsuleNormal, ...capsuleNormal, ...capsuleNormal,
  ]), 3));
  const actualMaterials = [0, 1.44e-6].map(reliefM => {
    const material = new MeshPhysicalMaterial({ roughness: .16, ior: 1.35 });
    installLiverFilmOptics(material, texture, false, reliefM, .43);
    const productCompile = material.onBeforeCompile, productKey = material.customProgramCacheKey();
    const directSpecularOnly = { value: false };
    material.onBeforeCompile = (shader, renderer) => {
      productCompile.call(material, shader, renderer);
      // Preserve the product BRDF, h==0 exclusion, opacity and output path.
      // Intensity-on minus intensity-off is NOT an isolated specular response:
      // Three also changes directDiffuse by (1-F), which depends on slab colour.
      const output = "#include <opaque_fragment>";
      if (!shader.fragmentShader.includes(output)) throw new Error("Physical shader output hook changed");
      shader.uniforms.uOracleDirectSpecularOnly = directSpecularOnly;
      shader.fragmentShader = `uniform bool uOracleDirectSpecularOnly;\n${shader.fragmentShader}`.replace(output,
        `if (uOracleDirectSpecularOnly) outgoingLight = reflectedLight.directSpecular;\n${output}`);
    };
    material.customProgramCacheKey = () => `${productKey}-direct-specular-oracle-1`;
    return { reliefM, material, directSpecularOnly };
  });
  let actual = actualMaterials[0]!.material;
  const reference = new MeshPhysicalMaterial({ roughness: .16, ior: 1.35 });
  const underlying = new MeshPhysicalMaterial({ color: new Color().setRGB(.35, .18, .04), roughness: .7, ior: 1.35 });
  const film = new Mesh(geometry, actual), tissue = new Mesh(backGeometry, underlying);
  film.renderOrder = 1; tissue.position.z = -.01;
  const scene = new Scene(); scene.add(tissue, film);
  const light = new DirectionalLight(0xffffff, 1); light.position.set(.25, 0, 2); scene.add(light, light.target);
  const camera = new OrthographicCamera(-1, 1, 1, -1, .1, 10); camera.position.z = 2;
  const hdr = new Float32Array(4), display = new Uint8Array(4), gl = gpu.getContext();
  const draw = (material: MeshPhysicalMaterial, visible: boolean, toneMapped: boolean) => {
    film.material = material; film.visible = visible;
    const normal = material === reference ? expectedNormal : [0, 0, 1];
    const attribute = geometry.getAttribute("normal");
    for (let i = 0; i < attribute.count; i++) attribute.setXYZ(i, normal[0]!, normal[1]!, normal[2]!);
    attribute.needsUpdate = true;
    gpu.toneMapping = toneMapped ? ACESFilmicToneMapping : NoToneMapping;
    gpu.setRenderTarget(toneMapped ? null : target); gpu.render(scene, camera);
    if (toneMapped) {
      gl.readPixels(16, 16, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, display);
      return Array.from(display);
    }
    gpu.readRenderTargetPixels(target, 16, 16, 1, 1, hdr);
    return Array.from(hdr);
  };
  let maximumHdrError = 0, maximumDisplayByteError = 0, minimumSpecular = Infinity, maximumSpecular = -Infinity;
  let comparisons = 0, maximumSpecularChannelDifference = 0;
  const tailCases: { depthM: number; leveling: number; referenceRoughness: number }[] = [];
  try {
    for (const { reliefM, material, directSpecularOnly } of actualMaterials) {
      actual = material;
      for (const saturation of [.75, .98]) {
      liverFilmTransportTextureData(saturation, texture.image.data as Float32Array); texture.needsUpdate = true;
      for (const h of [0, 1e-12, 1e-9, 1e-6, .00005, .001]) {
        thickness.fill(h); geometry.getAttribute("liverThicknessM").needsUpdate = true;
        const expected = liverFilmOpticalRGBA(thickness[0]!, saturation, [.18, .04, .025]);
        reference.color.setRGB(expected[0], expected[1], expected[2]);
        reference.roughness = liverFilmInterfaceRoughness(thickness[0]!, reliefM, .43, .16);
        const weight = liverFilmLevelingFactor(thickness[0]!, reliefM);
        const nx = capsuleNormal[0]! * (1 - weight), nz = capsuleNormal[2]! * (1 - weight) + weight;
        const normalLength = Math.hypot(nx, nz);
        expectedNormal.splice(0, 3, nx / normalLength, 0, nz / normalLength);
        const observedHdr = draw(actual, true, false), expectedHdr = draw(reference, h > 0, false);
        const observedDisplay = draw(actual, true, true), expectedDisplay = draw(reference, h > 0, true);
        for (let channel = 0; channel < 4; channel++) {
          maximumHdrError = Math.max(maximumHdrError, Math.abs(observedHdr[channel]! - expectedHdr[channel]!));
          maximumDisplayByteError = Math.max(maximumDisplayByteError,
            Math.abs(observedDisplay[channel]! - expectedDisplay[channel]!));
        }
        if (h > 0 && reliefM === 0) {
          directSpecularOnly.value = true;
          const specular = draw(actual, true, false);
          directSpecularOnly.value = false;
          for (const channel of specular.slice(0, 3)) {
            minimumSpecular = Math.min(minimumSpecular, channel);
            maximumSpecular = Math.max(maximumSpecular, channel);
            maximumSpecularChannelDifference = Math.max(maximumSpecularChannelDifference,
              Math.abs(channel - specular[0]!));
          }
        }
        if (reliefM > 0 && saturation === .75)
          tailCases.push({ depthM: h, leveling: weight, referenceRoughness: reference.roughness });
        comparisons++;
      }
      }
    }
    return { passed: maximumHdrError < 5e-5 && maximumDisplayByteError <= 1 &&
      minimumSpecular > .001 && maximumSpecular - minimumSpecular < 5e-5 &&
      maximumSpecularChannelDifference < 5e-5,
      comparisons, maximumHdrError, maximumDisplayByteError, minimumSpecular, maximumSpecular,
      maximumSpecularChannelDifference, tailCases,
      specularExtraction: "Actual reflectedLight.directSpecular through product opacity/output; no intensity subtraction",
      hdrTolerance: 5e-5, displayToleranceBytes: 1,
      scope: "Full product linear composition + physical material + ACES/sRGB output; no calibrated tissue BRDF claim" };
  } finally {
    geometry.dispose(); backGeometry.dispose(); actualMaterials.forEach(({ material }) => material.dispose());
    reference.dispose(); underlying.dispose(); texture.dispose(); target.dispose();
    gpu.dispose(); gpu.forceContextLoss();
  }
}
/** Real browser allocations fail at public DOM/geometry boundaries. No private
 * renderer hook is added to production code. Restore all interceptors before
 * another renderer is created, and verify actual context/source ownership.
 */
async function constructorFailureOracle(anatomy: LiverAnatomy) {
  const rows: Record<string, unknown>[] = [];
  for (const stage of ["canvas-append", "atlas-attributes", "atlas-and-cleanup"] as const) {
    const host = document.createElement("div"), sentinel = document.createElement("span");
    host.appendChild(sentinel); document.body.appendChild(host);
    const fault = new Error(`Injected ${stage} construction failure`), cleanupFault = new Error("Injected controls cleanup failure");
    const observed: { canvas?: HTMLCanvasElement; failure?: unknown } = {};
    const seen = new Set<BufferGeometry>(), engineOwned = new Set<BufferGeometry>(), disposed = new Set<BufferGeometry>();
    let controlDisposals = 0, materialDisposals = 0, injected = false;
    const append = host.appendChild, setAttribute = BufferGeometry.prototype.setAttribute;
    const disposeGeometry = BufferGeometry.prototype.dispose, disposeMaterial = Material.prototype.dispose;
    const disposeControls = OrbitControls.prototype.dispose;
    try {
      host.appendChild = function<T extends Node>(node: T): T {
        const result = append.call(this, node) as T;
        if (node instanceof HTMLCanvasElement) {
          observed.canvas = node;
          if (stage === "canvas-append") { injected = true; throw fault; }
        }
        return result;
      };
      BufferGeometry.prototype.setAttribute = function(name, attribute) {
        // WebGLRenderer creates an engine-private shadow full-screen triangle
        // before handing out its canvas. LiverRenderer has not allocated any
        // application geometry at that point and cannot own/dispose that
        // private object. Verify engine cleanup by actual context loss; require
        // dispose events for all subsequent application-owned geometry.
        (observed.canvas ? seen : engineOwned).add(this);
        if (name === "atlasRestPosition" && stage !== "canvas-append") { injected = true; throw fault; }
        return setAttribute.call(this, name, attribute);
      };
      BufferGeometry.prototype.dispose = function() { disposed.add(this); disposeGeometry.call(this); };
      Material.prototype.dispose = function() { materialDisposals++; disposeMaterial.call(this); };
      OrbitControls.prototype.dispose = function() {
        controlDisposals++; disposeControls.call(this);
        if (stage === "atlas-and-cleanup") throw cleanupFault;
      };
      try {
        const unexpected = new LiverRenderer(host, { anatomy, onSurfacePick: () => {} });
        unexpected.dispose();
      } catch (cause) { observed.failure = cause; }
      await frames();
      const canvas = observed.canvas, failure = observed.failure;
      const originalCauseRetained = failure === fault ||
        (failure instanceof AggregateError && failure.cause === fault && failure.errors.includes(fault));
      const cleanupCauseRetained = stage !== "atlas-and-cleanup" ||
        (failure instanceof AggregateError && failure.errors.some(item =>
          item instanceof AggregateError && item.errors.includes(cleanupFault)));
      const contextLost = canvas?.getContext("webgl2")?.isContextLost() === true;
      const allObservedGeometryDisposed = [...seen].every(geometry => disposed.has(geometry));
      const passed = injected && originalCauseRetained && cleanupCauseRetained && contextLost &&
        !!canvas && !canvas.isConnected && !getSceneRecordingSource(canvas) &&
        host.childNodes.length === 1 && host.firstChild === sentinel &&
        (stage === "canvas-append" || (controlDisposals === 1 && materialDisposals > 0 && allObservedGeometryDisposed));
      rows.push({ stage, passed, injected, originalCauseRetained, cleanupCauseRetained, contextLost,
        controlDisposals, materialDisposals, observedGeometries: seen.size,
        disposedGeometries: disposed.size, allObservedGeometryDisposed,
        engineOwnedGeometry: [...engineOwned].map(geometry => ({
          type: geometry.type, positionVertices: geometry.getAttribute("position")?.count ?? 0,
          applicationDisposeEvent: disposed.has(geometry),
        })) });
    } finally {
      host.appendChild = append; BufferGeometry.prototype.setAttribute = setAttribute;
      BufferGeometry.prototype.dispose = disposeGeometry; Material.prototype.dispose = disposeMaterial;
      OrbitControls.prototype.dispose = disposeControls; host.remove();
    }
  }
  return { passed: rows.every(row => row.passed), cases: rows };
}
export async function liverRendererBench() {
  const checks: Check[] = [], captures: { name: string; dataUrl: string }[] = [], errors: string[] = [];
  const check = (name: string, passed: boolean, details?: unknown) => {
    checks.push({ name, passed, ...(details !== undefined ? { details } : {}) });
    if (!passed) throw new Error(name);
  };
  const host = document.createElement("div");
  host.style.cssText = "position:relative;width:1200px;height:760px";
  document.body.appendChild(host);
  let view: LiverRenderer | undefined;
  try {
    const optical = fragmentOpticsOracle();
    check("Native per-fragment P1 optics agrees with the CPU spectral/slab reference", optical.passed, optical);
    const shaded = shadedOpticsOracle();
    check("Complete wet stack composes before PBR/tone mapping without alpha-fading its dielectric reflection", shaded.passed, shaded);
    const operating = operatingEmitterOracle();
    check("Finite operating panel matches independently normalized diffuse irradiance", operating.passed, operating);
    const anatomy = await loadLiverAnatomy(), anatomyBefore = snapshot(anatomy);
    const construction = await constructorFailureOracle(anatomy);
    check("Partial constructor failures release native ownership and preserve the original cause", construction.passed, construction);
    const model = new LiverFlowExperiment(anatomy, { kind: "vein" });
    let picks = 0;
    view = new LiverRenderer(host, { anatomy, onSurfacePick: () => { picks++; }, onError: error => errors.push(error) });
    view.update(model.snapshot()); view.render(); await frames();
    const initialPhysics = snapshot(model.snapshot()), canvas = view.canvas;
    check("Real licensed capsule has a native registered recording source", !!getSceneRecordingSource(canvas));
    check("Rendered collection floor equals the physical ballistic contact plane in SI",
      Math.abs(view.visualState.collectionPlaneYM - model.vesselConfig.collectionPlaneYM) < 1e-15,
      { renderedYM: view.visualState.collectionPlaneYM, physicalYM: model.vesselConfig.collectionPlaneYM });
    check("Initial organ is dry without phantom film", view.visualState.filmVolumeM3 === 0 && view.visualState.wetVertices === 0);
    check("Initial collector is exactly dry and uses its authoritative finite domain",
      view.visualState.collector.acceptedVolumeM3 === 0 && view.visualState.collector.reconstructedVolumeM3 === 0 &&
      !view.visualState.collector.visible && snapshot(view.visualState.collector.domain) === snapshot(model.snapshot().collector.domain));
    const target = anatomy.targets[0]!;
    view.setMode("cut"); view.focusTarget(target.id); view.render();
    const inspectionRig = view.visualState.cameraRig;
    const rigIrradiance = (rig: typeof inspectionRig) => rig.relativeLampIntensity / (rig.workingDistanceM * 1000) ** 2;
    check("Inspection uses the actual nearer camera with zoom1",
      inspectionRig.zoom === 1 &&
      Math.abs(inspectionRig.workingDistanceM - inspectionRig.inspectionWorkingDistanceM) < 1e-12, inspectionRig);
    canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "+", bubbles: true, cancelable: true })); view.render();
    const dollyRig = view.visualState.cameraRig;
    check("Declared automatic lamp adjusts emitted intensity without modifying exposure or physical time",
      dollyRig.workingDistanceM < inspectionRig.workingDistanceM &&
      dollyRig.relativeLampIntensity < inspectionRig.relativeLampIntensity &&
      Math.abs(rigIrradiance(inspectionRig) - inspectionRig.referenceRelativeIrradiance) < 1e-12 &&
      Math.abs(rigIrradiance(dollyRig) - dollyRig.referenceRelativeIrradiance) < 1e-12 &&
      view.visualState.appearance.exposureEV === 0 && snapshot(model.snapshot()) === initialPhysics,
      { inspectionRig, dollyRig });
    canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "-", bubbles: true, cancelable: true })); view.render();
    const reverseDollyRig = view.visualState.cameraRig;
    check("Minus reverses keyboard approach and restores the physical lamp distance",
      reverseDollyRig.workingDistanceM > dollyRig.workingDistanceM &&
      Math.abs(reverseDollyRig.workingDistanceM - inspectionRig.workingDistanceM) < 1e-12 &&
      Math.abs(reverseDollyRig.relativeLampIntensity / inspectionRig.relativeLampIntensity - 1) < 1e-12,
      { reverseDollyRig });
    view.fitLiver(); view.render();
    check("Fit liver restores a whole-organ camera without lens magnification",
      view.visualState.cameraRig.zoom === 1 &&
      view.visualState.cameraRig.workingDistanceM > inspectionRig.workingDistanceM);
    view.focusTarget(target.id); view.render();
    const projected = view.visualState.projectedTargets.find(item => item.id === target.id)!;
    const hit = view.pick(projected.clientX, projected.clientY);
    check("Actual displayed capsule raycast recovers the selected surface target", projected.visible && !!hit &&
      Math.hypot(...hit.positionM.map((value, axis) => value - target.pick.positionM[axis]!)) < 1e-7);
    check("Focus and real picking cannot commit a cut or integrate physics", picks === 0 && snapshot(model.snapshot()) === initialPhysics);
    check("Coordinates outside the actual canvas are a genuine miss", view.pick(-100, -100) === null);
    // Explicit analytic rendering fixtures, not a claim that these inventories
    // came from the coupled flow. They cover morphology and true-dry handoff
    // independently before the real integrated trajectory below.
    const fixture = model.snapshot();
    fixture.runoff.attached = [{ ...runoffAttachedGeometry(target.pick.positionM, target.pick.normal, 2e-8, .001, .0005),
      id: "renderer-analytic-support", anchorSurface: { triangle: target.pick.triangle, barycentric: [...target.pick.barycentric] } }];
    fixture.runoff.attachedVolumeM3 = 2e-8;
    fixture.runoff.droplets = [{ id: 0, positionM: [...target.pick.positionM], velocityMS: [0, 0, 0],
      radiusM: Math.cbrt(3e-9 / (4 * Math.PI)), volumeM3: 1e-9, birthTimeSeconds: 0 }];
    fixture.runoff.inFlightVolumeM3 = 1e-9;
    const { widthM, depthM, nx, nz } = fixture.collector.domain;
    fixture.collector.heightM[nx * Math.floor(nz / 2) + Math.floor(nx / 2)] = .0002;
    fixture.collector.filmVolumeM3 = .0002 * widthM * depthM / (nx * nz);
    const fixtureBefore = snapshot(fixture); view.update(fixture); view.render();
    const fixtureVisual = view.visualState;
    check("Accepted runoff supports and detached spheres have measured physical visible inventory",
      fixtureVisual.runoff.attachedCount === 1 && fixtureVisual.runoff.attachedAcceptedVolumeM3 === 2e-8 &&
      fixtureVisual.runoff.maximumTessellationRelativeError < .004 &&
      fixtureVisual.runoff.inFlightVolumeM3 === 1e-9 && fixtureVisual.runoffDropletCount === 1,
      fixtureVisual.runoff);
    check("A local collector deposit is reconstructed conservatively without a uniform fill",
      fixtureVisual.collector.visible &&
      Math.abs(fixtureVisual.collector.reconstructedVolumeM3 / fixture.collector.filmVolumeM3 - 1) < 5e-7,
      fixtureVisual.collector);
    check("Rendering fixtures never mutate the accepted buffers or independent model",
      snapshot(fixture) === fixtureBefore && snapshot(model.snapshot()) === initialPhysics);
    const invalidCollector = model.snapshot(); invalidCollector.collector.heightM[0] = NaN;
    const beforeInvalidCollector = snapshot(view.visualState); let collectorRejected = false;
    try { view.update(invalidCollector); } catch { collectorRejected = true; }
    check("Invalid collector input preserves the whole last visible state",
      collectorRejected && snapshot(view.visualState) === beforeInvalidCollector);
    fixture.collector.heightM.fill(NaN); fixture.runoff.attached[0]!.anchorM = [NaN, 0, 0];
    view.setAppearance({ oxygenationFraction: .75 }); view.render();
    check("Appearance changes do not reread caller-owned runoff or collector buffers",
      snapshot(view.visualState.runoff) === snapshot(fixtureVisual.runoff) &&
      snapshot(view.visualState.collector) === snapshot(fixtureVisual.collector));
    view.update(model.snapshot()); view.render();
    check("An accepted zero inventory removes runoff supports and the collector wet layer",
      view.visualState.runoff.attachedCount === 0 && view.visualState.runoffDropletCount === 0 &&
      !view.visualState.collector.visible && view.visualState.collector.reconstructedVolumeM3 === 0);
    const dryPixels = canvas.toDataURL("image/png"), dryVisual = snapshot(view.visualState), tinyFixture = model.snapshot();
    for (let repeat = 0; repeat < 3; repeat++) { view.update(model.snapshot()); view.render(); }
    check("Unchanged film and exact-dry collector reuse preserve the complete visible state and pixels",
      snapshot(view.visualState) === dryVisual && canvas.toDataURL("image/png") === dryPixels);
    const invalidDry = model.snapshot(); invalidDry.collector.heightM[invalidDry.collector.heightM.length - 1] = NaN;
    let invalidDryRejected = false;
    try { view.update(invalidDry); } catch { invalidDryRejected = true; }
    view.render();
    check("The exact-dry display shortcut still rejects invalid last-cell heights before visible mutation",
      invalidDryRejected && snapshot(view.visualState) === dryVisual && canvas.toDataURL("image/png") === dryPixels);
    const tinyVolume = 3.362328649924974e-135;
    const setFixtureVolume = (volume: number) => {
      tinyFixture.runoff.attached = [{ ...runoffAttachedGeometry(target.pick.positionM, target.pick.normal,
        volume, .0005, .00025), id: "renderer-underflow-support",
        anchorSurface: { triangle: target.pick.triangle, barycentric: [...target.pick.barycentric] } }];
      tinyFixture.runoff.attachedVolumeM3 = volume;
    };
    setFixtureVolume(tinyVolume);
    const tinyBefore = snapshot(tinyFixture); view.update(tinyFixture); view.render();
    check("Float32-underflow supports retain exact inventory and add no pixels or optical coverage",
      view.visualState.runoff.unresolvedDisplayCount === 1 &&
      view.visualState.runoff.unresolvedDisplayVolumeM3 === tinyVolume &&
      view.visualState.runoff.attachedAcceptedVolumeM3 === tinyVolume &&
      view.visualState.runoff.attachedReconstructedVolumeM3 === 0 &&
      view.visualState.runoff.unresolvedDisplayVolumeM3 <= view.visualState.runoff.unresolvedDisplayVolumeBoundM3 &&
      canvas.toDataURL("image/png") === dryPixels && snapshot(tinyFixture) === tinyBefore,
      view.visualState.runoff);
    setFixtureVolume(2e-9); view.update(tinyFixture); view.render();
    check("The same support becomes visible when its accepted geometry becomes representable",
      view.visualState.runoff.unresolvedDisplayCount === 0 &&
      view.visualState.runoff.attachedReconstructedVolumeM3 > 0 &&
      view.visualState.runoff.maximumTessellationRelativeError < .004 &&
      canvas.toDataURL("image/png") !== dryPixels);
    setFixtureVolume(tinyVolume); view.update(tinyFixture); view.render();
    check("An underflow transition hides obsolete resolved geometry without losing its remaining mass",
      view.visualState.runoff.unresolvedDisplayVolumeM3 === tinyVolume &&
      view.visualState.runoff.attachedReconstructedVolumeM3 === 0 &&
      canvas.toDataURL("image/png") === dryPixels);
    view.update(model.snapshot()); view.render();
    const chosen = prepareLiverCut(anatomy, [], { pick: target.pick, radiusM: .001, depthM: .0015, timeSeconds: 0 });
    check("Physical target resolves to a real procedural vessel intersection", chosen.accepted && chosen.outcome === "vessel-hit");
    const wound = chosen.wound!;
    view.setWounds([wound]); model.setWounds([wound]); view.update(model.snapshot()); view.render();
    check("Actual cavity replaces capsule triangles", view.visualState.woundCount === 1 &&
      view.visualState.cavityTriangles > 0 && view.visualState.removedAreaM2 > 0);
    const afterCut = snapshot(model.snapshot());
    for (let i = 0; i < 3; i++) view.render();
    check("Repeated draws preserve the exact accepted physical state", snapshot(model.snapshot()) === afterCut);
    const invalid = model.snapshot(); invalid.film.depthM[0] = NaN;
    const beforeInvalid = snapshot(view.visualState);
    let rejected = false; try { view.update(invalid); } catch { rejected = true; }
    check("Invalid numerical state is rejected without corrupting the visible accepted state",
      rejected && snapshot(view.visualState) === beforeInvalid);
    const caller = model.snapshot(); view.update(caller);
    caller.film.depthM.fill(NaN); caller.film.vertexAreaM2.fill(NaN);
    view.setAppearance({ oxygenationFraction: .75 }); view.render();
    check("Renderer retains owned film data after caller buffers change", view.visualState.filmVolumeM3 === 0);
    // Run real accepted physics; this gate cannot certify physiological fidelity.
    for (let i = 0; i < 50; i++) {
      const result = model.step(); check(`Accepted coupled step ${i + 1}`, result.accepted, result.reason);
    }
    view.update(model.snapshot()); view.render();
    check("Rendered film volume matches accepted physical inventory",
      Math.abs(view.visualState.filmVolumeM3 - model.snapshot().film.filmVolumeM3) <=
        Math.max(1e-16, model.snapshot().film.filmVolumeM3 * 1e-7));
    check("Actual coupled runoff and collector clocks and inventories agree with display",
      view.visualState.runoff.attachedAcceptedVolumeM3 === model.snapshot().runoff.attachedVolumeM3 &&
      view.visualState.runoff.inFlightVolumeM3 === model.snapshot().runoff.inFlightVolumeM3 &&
      Math.abs(view.visualState.collector.reconstructedVolumeM3 - model.snapshot().collector.filmVolumeM3) <=
        Math.max(1e-20, model.snapshot().collector.filmVolumeM3 * 5e-7));
    const cameraImage = canvas.toDataURL("image/png");
    captures.push({ name: "liver-detail-accepted", dataUrl: cameraImage });
    const paused = snapshot(model.snapshot());
    const acceptedCameraPose = snapshot({ position: view.visualState.cameraPosition, target: view.visualState.cameraTarget });
    view.setAppearance({ illumination: "operating" }); view.render();
    const operatingImage = canvas.toDataURL("image/png"), panelBeforeOrbit = snapshot(view.visualState.operatingLight);
    check("Operating mode changes actual lighting while preserving camera, exposure and accepted blood",
      operatingImage !== cameraImage && view.visualState.operatingLight.enabled &&
      view.visualState.appearance.exposureEV === 0 && snapshot(model.snapshot()) === paused &&
      snapshot({ position: view.visualState.cameraPosition, target: view.visualState.cameraTarget }) === acceptedCameraPose,
      view.visualState.operatingLight);
    captures.push({ name: "liver-detail-operating-panel", dataUrl: operatingImage });
    canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })); view.render();
    check("The operating apparatus stays fixed when the camera orbits",
      snapshot(view.visualState.operatingLight) === panelBeforeOrbit && snapshot(model.snapshot()) === paused);
    captures.push({ name: "liver-detail-operating-orbit", dataUrl: canvas.toDataURL("image/png") });
    view.focusTarget(target.id); view.setAppearance({ illumination: "studio" }); view.render();
    captures.push({ name: "liver-detail-studio", dataUrl: canvas.toDataURL("image/png") });
    view.setAppearance({ illumination: "camera" }); view.render();
    check("Camera-light mode remains available with its unchanged relative irradiance",
      !view.visualState.operatingLight.enabled && view.visualState.appearance.illumination === "camera" &&
      Math.abs(rigIrradiance(view.visualState.cameraRig) - inspectionRig.referenceRelativeIrradiance) < 1e-12 &&
      snapshot(model.snapshot()) === paused);
    const intactTarget = anatomy.targets.find(item => item.id !== target.id)!;
    view.focusTarget(intactTarget.id); view.render();
    const source = getSceneRecordingSource(canvas)!;
    const recordingRig = snapshot(view.visualState.cameraRig);
    for (const [width, height] of [[1280, 720], [3840, 2160]] as const) {
      const abort = new AbortController(), lease = source.prepare({ width, height, fps: 30, signal: abort.signal });
      check(`Native ${width}×${height} owns the exact draw buffer`, canvas.width === width && canvas.height === height && view.visualState.recording);
      let exclusive = false;
      try { source.prepare({ width, height, fps: 30, signal: new AbortController().signal }); } catch { exclusive = true; }
      check(`Native ${width}×${height} rejects a second owner`, exclusive);
      host.style.width = "760px"; host.style.height = "900px"; await frames(); view.render();
      check(`Native ${width}×${height} survives host resizing`, canvas.width === width && canvas.height === height);
      const visible = view.visualState.projectedTargets.find(item => item.id === intactTarget.id);
      check(`Native ${width}×${height} picking uses its letterboxed rectangle`,
        !!visible?.visible && view.pick(visible.clientX, visible.clientY) !== null);
      check(`Native ${width}×${height} never advances simulation`, snapshot(model.snapshot()) === paused);
      check(`Native ${width}×${height} preserves the actual camera rig and lamp`,
        snapshot(view.visualState.cameraRig) === recordingRig);
      if (width === 3840) captures.push({ name: "liver-native-4k", dataUrl: canvas.toDataURL("image/png") });
      abort.abort(); lease.restore(); await frames();
      check(`Native ${width}×${height} cancellation restores normal viewport ownership`, !view.visualState.recording &&
        canvas.dataset.sceneRecordingActive !== "true" && canvas.width !== width);
    }
    check("Anatomy and source material buffers remain unchanged", snapshot(anatomy) === anatomyBefore);
    const gl = canvas.getContext("webgl2")!;
    const lose = gl.getExtension("WEBGL_lose_context");
    if (!lose) throw new Error("Context-loss testing requires WEBGL_lose_context");
    const lost = event(canvas, "webglcontextlost"); lose.loseContext(); await lost;
    check("Actual context loss disables rendering and reports one failure", view.visualState.contextLost && !view.needsRender && errors.length === 1);
    let unavailable = false;
    try { source.prepare({ width: 1280, height: 720, fps: 30, signal: new AbortController().signal }); } catch { unavailable = true; }
    check("A lost scene cannot acquire another recording lease", unavailable);
    view.dispose(); view.dispose();
    check("Idempotent disposal removes the native source and canvas", !getSceneRecordingSource(canvas) && !canvas.isConnected);
    return { status: "PASS", checks, captures, errors };
  } catch (cause) {
    checks.push({ name: cause instanceof Error ? cause.message : String(cause), passed: false });
    return { status: "FAIL", checks, captures, errors, error: String(cause instanceof Error ? cause.stack : cause) };
  } finally { view?.dispose(); host.remove(); }
}
