import {
  ACESFilmicToneMapping, Box3, BoxGeometry, BufferAttribute, BufferGeometry, Color, CylinderGeometry, DataTexture, DirectionalLight, DynamicDrawUsage,
  FloatType, NearestFilter, RGBAFormat,
  FrontSide, InstancedMesh, LineBasicMaterial, LineSegments, Matrix3, Matrix4, Mesh,
  MeshBasicMaterial, MeshPhysicalMaterial, MeshStandardMaterial, MOUSE, PCFShadowMap, PerspectiveCamera,
  PlaneGeometry, PMREMGenerator, Quaternion, Raycaster, RectAreaLight, RingGeometry, Scene, Sphere, SphereGeometry,
  SpotLight, SRGBColorSpace, Triangle, Vector2, Vector3, WebGLRenderer, type WebGLRenderTarget,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { RectAreaLightUniformsLib } from "three/examples/jsm/lights/RectAreaLightUniformsLib.js";
import { registerSceneRecordingSource } from "../../sceneRecordingSource";
import { installAtlasMaterial, readAtlasMaterial, type AtlasMaterialDefinition } from "../../atlasMaterialShader";
import { sampleMaterialField } from "../../atlasMaterialSampler";
import { installPhotoDetail, photoDetailFor, type PhotoDetail } from "../../photoDetail";
import { composeDiffuseSubstrate } from "../optics";
import { bloodAppearanceTransport } from "../experiments/bloodAppearanceOptics";
import { APPEARANCE_LOG_MAX, APPEARANCE_MAX_M, APPEARANCE_SCALE_M,
  APPEARANCE_THICKNESS_COUNT } from "../experiments/bloodAppearanceLut.generated";
import { relativeCameraLightPower } from "../experiments/appearance";
import { closedTriangleVolumeM3, ligamentGeometryData, validateDroplets,
  type DropletGeometryInput } from "../experiments/breakupGeometry";
import { buildLiverCutGeometry } from "./wounds";
import { liverCollectionPlaneYM } from "./collectionPlane";
import { attachedRunoffGeometry, prepareDryCollectorDisplay } from "./runoffGeometry";
import { DRY_COLLECTOR_MODEL, type DryCollectorDomain } from "./dryCollector";
import type { RunoffAttached } from "./runoff";
import type {
  LiverAnatomy, LiverAppearance, LiverCutGeometry, LiverFilmSnapshot, LiverFlowSnapshot,
  LiverSurface, LiverSurfacePick, LiverVec3, LiverVesselSegment, LiverWound,
} from "./types";

export interface LiverRendererOptions {
  anatomy: LiverAnatomy;
  onSurfacePick(pick: LiverSurfacePick): void;
  onHover?: (pick: LiverSurfacePick | null) => void;
  onError?: (message: string) => void;
}
/** Predicted outcome of a cut at the hovered site (see `cutPreview.ts`). Display only. */
export interface LiverRendererCutPreview { status: "vessel" | "deeper" | "tissue" | "blocked"; segment: LiverVesselSegment | null }
export const LIVER_CUT_PREVIEW_COLOURS = Object.freeze({ idle: "#ffc570", vessel: "#ff4d63", deeper: "#ffb347", tissue: "#8fd3ff", blocked: "#9aa1ab" });
type Disposable = { dispose(): void };
type Gesture = { id: number; startX: number; startY: number; moved: boolean; pick: LiverSurfacePick | null };
type AttachedDisplay = {
  mesh: Mesh<BufferGeometry, MeshPhysicalMaterial>;
  signature: string;
  data: ReturnType<typeof attachedRunoffGeometry>;
  definition: AtlasMaterialDefinition | null;
};
const DEFAULT_APPEARANCE: LiverAppearance = {
  illumination: "camera", exposureEV: 0, vesselGuide: true, oxygenationFraction: .98,
};
const MM = 1000;
// Presentation authoring, not measured tissue parameters. A single aqueous
// dielectric interface avoids stacking an automotive-style clearcoat over the
// capsule. Photograph luminance is colour evidence, not a measured height map.
const CAPSULE_IOR = 1.35;
const CAPSULE_RELIEF_SCALE = .12;
const PHOTO_COLOUR_STRENGTH = .45;
/** Presentation-only relief of the blood film (see updateLiverFilmCache).
 * h_vis = maximum·tanh(h/s), s = max(minimumScale, peakFraction·peak depth);
 * ripple amplitude/speed are authored liquid-surface detail whose clock and
 * strength follow accepted wound outflow. None of these alter physics. */
export const LIVER_FILM_VISUAL_RELIEF = Object.freeze({
  maximumM: 1.6e-3, minimumScaleM: 4e-5, peakFraction: .9,
  rippleAmplitudeMm: .075, rippleWavelengthMm: 2.6, rippleSpeedMmS: 22, rippleReferenceFlowM3S: 1e-7,
  environmentReflectionGain: 3.2, opticalSaturationM: 2.5e-5,
  /** Albedo multiplier at the deepest part of the dome: a thick pool reads
   * maroon, thin rim stays scarlet (Beer–Lambert over a bright substrate). */
  coreDarkening: .58,
  /** ± fraction of the core darkening modulated by the advected flow field. */
  flowStreakContrast: .35,
});
export function liverFilmReliefScaleM(peakDepthM: number) {
  return Math.max(LIVER_FILM_VISUAL_RELIEF.minimumScaleM, LIVER_FILM_VISUAL_RELIEF.peakFraction * (Number.isFinite(peakDepthM) ? peakDepthM : 0));
}
/** Smoothly saturating flow activity in [0, 1) from total wound outflow. */
export function liverFilmFlowActivity(flowM3S: number) {
  return Number.isFinite(flowM3S) && flowM3S > 0 ? 1 - Math.exp(-flowM3S / LIVER_FILM_VISUAL_RELIEF.rippleReferenceFlowM3S) : 0;
}
/** Level-set shift that places the visual contact line inside the dilated support. */
export function liverFilmContactCutoffM(peakDepthM: number) {
  return Math.min(18e-6, Math.max(0, peakDepthM) * .11);
}
type LiverFilmUniforms = { clock: { value: number }; activity: { value: number }; reliefScale: { value: number } };
function liverFilmUniforms(material: MeshPhysicalMaterial): LiverFilmUniforms {
  return (material.userData.liverFilmUniforms ??= { clock: { value: 0 }, activity: { value: 0 },
    reliefScale: { value: LIVER_FILM_VISUAL_RELIEF.minimumScaleM } }) as LiverFilmUniforms;
}
const CAMERA_IRRADIANCE = Math.PI * .5;
const INSPECTION_OBLIQUITY = 18 * Math.PI / 180;
export const LIVER_OPERATING_PANEL = Object.freeze({
  widthM: .4, heightM: .3, workingDistanceM: .6, referenceRelativeIrradiance: CAMERA_IRRADIANCE,
});
let areaLightUniformsReady = false;
export function initializeLiverAreaLightUniforms() {
  // These library LUTs are shared immutable resources, not per-view textures.
  if (areaLightUniformsReady) return;
  RectAreaLightUniformsLib.init(); areaLightUniformsReady = true;
}
/** ∫A cos(theta_receiver) cos(theta_emitter)/r² dA for a parallel,
 * centred finite rectangle. Multiplying by emitted radiance gives irradiance.
 * Coordinates are metres; the dimensionless form factor is scale invariant.
 * This is an authored laboratory panel, not measured surgical equipment.
 */
export function rectangularEmitterProjectedSolidAngle(widthM: number, heightM: number, distanceM: number) {
  if (![widthM, heightM, distanceM].every(value => Number.isFinite(value) && value > 0))
    throw new RangeError("Operating emitter needs finite positive dimensions and distance");
  const a = widthM / 2, b = heightM / 2, ad = Math.hypot(a, distanceM), bd = Math.hypot(b, distanceM);
  return 2 * (a / ad * Math.atan(b / ad) + b / bd * Math.atan(a / bd));
}
/** Same target-plane framing as the original distance=3.7R/zoom3, now obtained
 * by an actual nearer camera at zoom1. This is organ inspection, not a
 * calibrated endoscope or an inferred patient-camera pose. */
export function liverInspectionWorkingDistanceM(radiusM: number) {
  if (!Number.isFinite(radiusM) || radiusM <= 0) throw new RangeError("Inspection radius must be positive");
  return radiusM * 3.7 / 3;
}
const tuple = (point: Vector3): LiverVec3 => [point.x, point.y, point.z];
const copyPick = (pick: LiverSurfacePick): LiverSurfacePick => ({
  ...pick, positionM: [...pick.positionM], normal: [...pick.normal], barycentric: [...pick.barycentric],
});
const copyWound = (wound: LiverWound): LiverWound => ({ ...wound, pick: copyPick(wound.pick) });
const finitePoint = (point: ArrayLike<number>) => point.length === 3 && [point[0], point[1], point[2]].every(Number.isFinite);

/** The complete diffuse film/substrate stack, composed in linear light before
 * lighting and tone mapping. Alpha denotes actual coverage, not slab opacity:
 * h=0 has no film, h>0 shades the whole stack once with its own dielectric
 * interface. This avoids attenuating Fresnel reflection with diffuse opacity
 * or blending already-tone-mapped surface colours.
 * This remains a local diffuse approximation, not angular subsurface transport.
 */
export function liverFilmOpticalRGBA(depthM: number, oxygenation: number,
  substrate: readonly [number, number, number]): readonly [number, number, number, number] {
  if (!Number.isFinite(depthM) || depthM < 0 || !Number.isFinite(oxygenation) || oxygenation < 0 || oxygenation > 1)
    throw new RangeError("Invalid blood film optical state");
  if (depthM === 0) return [0, 0, 0, 0];
  const transport = bloodAppearanceTransport(depthM, oxygenation);
  const effective = composeDiffuseSubstrate(transport, substrate);
  return [effective[0], effective[1], effective[2], 1];
}

/** One oxygenation slice of the existing spectral LUT. The two RGBA rows are
 * R and T, with no invented colour/coverage or resampled physical thickness.
 * Explicit nearest-node fetch/interpolation avoids depending on optional
 * floating-point texture filtering on mobile devices.
 */
export function liverFilmTransportTextureData(oxygenation: number, target: Float32Array = new Float32Array(APPEARANCE_THICKNESS_COUNT * 8)) {
  if (!Number.isFinite(oxygenation) || oxygenation < 0 || oxygenation > 1 ||
      target.length !== APPEARANCE_THICKNESS_COUNT * 8) throw new RangeError("Invalid film lookup texture");
  for (let i = 0; i < APPEARANCE_THICKNESS_COUNT; i++) {
    const h = Math.expm1(i / (APPEARANCE_THICKNESS_COUNT - 1) * APPEARANCE_LOG_MAX) * APPEARANCE_SCALE_M;
    const transport = bloodAppearanceTransport(h, oxygenation);
    for (let channel = 0; channel < 3; channel++) {
      target[i * 4 + channel] = transport.reflectance[channel]!;
      target[(APPEARANCE_THICKNESS_COUNT + i) * 4 + channel] = transport.transmittance[channel]!;
    }
    target[i * 4 + 3] = target[(APPEARANCE_THICKNESS_COUNT + i) * 4 + 3] = 1;
  }
  return target;
}

/** Shared by the product film material and its independent native GPU oracle.
 * P1 thickness is interpolated first; nonlinear transport is evaluated second.
 */
export const LIVER_FILM_FRAGMENT_OPTICS = `
uniform sampler2D uLiverFilmTransport;
vec4 liverFilmOpticalLayer(float thicknessM, vec3 substrate) {
  if (thicknessM <= 0.0) return vec4(0.0);
  float coordinate = min(${APPEARANCE_THICKNESS_COUNT - 1}.0,
    log(1.0 + min(thicknessM, ${APPEARANCE_MAX_M}) / ${APPEARANCE_SCALE_M})
      / ${APPEARANCE_LOG_MAX} * ${APPEARANCE_THICKNESS_COUNT - 1}.0);
  float lower = floor(coordinate), upper = min(lower + 1.0, ${APPEARANCE_THICKNESS_COUNT - 1}.0);
  float u0 = (lower + 0.5) / ${APPEARANCE_THICKNESS_COUNT}.0;
  float u1 = (upper + 0.5) / ${APPEARANCE_THICKNESS_COUNT}.0;
  float fraction = coordinate - lower;
  vec3 r = mix(texture2D(uLiverFilmTransport, vec2(u0, 0.25)).rgb,
    texture2D(uLiverFilmTransport, vec2(u1, 0.25)).rgb, fraction);
  vec3 t = mix(texture2D(uLiverFilmTransport, vec2(u0, 0.75)).rgb,
    texture2D(uLiverFilmTransport, vec2(u1, 0.75)).rgb, fraction);
  // Convex interpolation is passive analytically; remove float32 roundoff.
  vec3 pairScale = max(vec3(1.0), r + t);
  r /= pairScale; t /= pairScale;
  vec3 s = clamp(substrate, vec3(0.0), vec3(1.0));
  vec3 denominator = max((vec3(1.0) - r) + r * (vec3(1.0) - s), vec3(1e-8));
  vec3 effective = min(vec3(1.0), r + t * (t * s / denominator));
  return vec4(effective, 1.0);
}
`;

/** Uncalibrated subgrid leveling closure, tied to the capsule's authored relief
 * amplitude in metres. It changes only the optical interface, never mass,
 * coverage, displacement, or the physical film pressure. The fourth-power
 * roughness blend is a microfacet slope-scale proxy, not a measured variance
 * of the heavy-tailed GGX distribution.
 */
export function liverFilmLevelingFactor(depthM: number, capsuleReliefM: number) {
  if (!Number.isFinite(depthM) || depthM < 0 || !Number.isFinite(capsuleReliefM) || capsuleReliefM < 0)
    throw new RangeError("Invalid film/capsule leveling scale");
  if (depthM === 0) return 0;
  if (capsuleReliefM === 0) return 1;
  return depthM >= capsuleReliefM ? 1 / (1 + capsuleReliefM / depthM)
    : (depthM / capsuleReliefM) / (1 + depthM / capsuleReliefM);
}
export function liverFilmInterfaceRoughness(depthM: number, capsuleReliefM: number,
  capsuleRoughness: number, fluidRoughness: number) {
  if (![capsuleRoughness, fluidRoughness].every(value => Number.isFinite(value) && value >= 0 && value <= 1))
    throw new RangeError("Invalid film/capsule roughness");
  const weight = liverFilmLevelingFactor(depthM, capsuleReliefM);
  return ((1 - weight) * capsuleRoughness ** 4 + weight * fluidRoughness ** 4) ** .25;
}
const LIVER_FILM_LEVELING = `
uniform float uLiverCapsuleReliefM;
uniform float uLiverCapsuleRoughness;
float liverFilmLeveling(float h) {
  if (h <= 0.0) return 0.0;
  return uLiverCapsuleReliefM > 0.0 ? h / (h + uLiverCapsuleReliefM) : 1.0;
}
float liverFilmMixedRoughness(float h, float capsule, float fluid) {
  return pow(mix(pow(capsule, 4.0), pow(fluid, 4.0), liverFilmLeveling(h)), 0.25);
}
`;

/** Install the product's complete linear diffuse stack and independent
 * dielectric boundary. Also used by the native shaded-material regression;
 * that gate exercises this actual material path, not a lookalike test shader.
 */
export function installLiverFilmOptics(material: MeshPhysicalMaterial, transportTexture: DataTexture,
  atlasSubstrate: boolean, capsuleReliefM = 0, capsuleRoughness = material.roughness, smoothContactOptics = false) {
  liverFilmInterfaceRoughness(0, capsuleReliefM, capsuleRoughness, material.roughness);
  material.vertexColors = false; material.clearcoat = 0; material.ior = 1.35; material.metalness = 0;
  material.transparent = false; material.opacity = 1; material.depthWrite = true;
  const baseCompile = material.onBeforeCompile, baseKey = material.customProgramCacheKey;
  material.onBeforeCompile = (shader, renderer) => {
    baseCompile.call(material, shader, renderer);
    shader.uniforms.uLiverFilmTransport = { value: transportTexture };
    shader.uniforms.uLiverCapsuleReliefM = { value: capsuleReliefM };
    shader.uniforms.uLiverCapsuleRoughness = { value: capsuleRoughness };
    if (smoothContactOptics) {
      const filmUniforms = liverFilmUniforms(material);
      shader.uniforms.uLiverFilmTime = filmUniforms.clock;
      shader.uniforms.uLiverFlowActivity = filmUniforms.activity;
      shader.uniforms.uLiverReliefScaleM = filmUniforms.reliefScale;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>
attribute float liverThicknessM;
attribute float liverSmoothThicknessM;
attribute vec3 liverSubstrateLinear;
attribute vec3 liverCapsuleNormal;
attribute vec3 liverSmoothNormal;
attribute vec3 liverSmoothGradient;
varying float vLiverThicknessM;
varying float vLiverSmoothThicknessM;
varying vec3 vLiverSubstrateLinear;
varying vec3 vLiverCapsuleNormal;
varying vec3 vLiverSmoothNormal;
varying vec3 vLiverSmoothGradient;
varying vec3 vLiverMetricPos;
varying float vLiverGradDotPos;
varying vec3 vLiverWorldPos;
varying vec3 vLiverWorldNormal;`)
        .replace("#include <begin_vertex>", `#include <begin_vertex>
vLiverThicknessM = liverThicknessM;
vLiverSmoothThicknessM = liverSmoothThicknessM;
vLiverSubstrateLinear = liverSubstrateLinear;
vLiverCapsuleNormal = normalMatrix * liverCapsuleNormal;
vLiverSmoothNormal = normalMatrix * liverSmoothNormal;
vLiverSmoothGradient = liverSmoothGradient;
vLiverMetricPos = position * 0.001;
vLiverGradDotPos = dot(liverSmoothGradient, position * 0.001);
vLiverWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
vLiverWorldNormal = mat3(modelMatrix) * liverCapsuleNormal;`);
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>
varying float vLiverThicknessM;
varying float vLiverSmoothThicknessM;
varying vec3 vLiverSubstrateLinear;
varying vec3 vLiverCapsuleNormal;
varying vec3 vLiverSmoothNormal;
varying vec3 vLiverSmoothGradient;
varying vec3 vLiverMetricPos;
varying float vLiverGradDotPos;
varying vec3 vLiverWorldPos;
varying vec3 vLiverWorldNormal;
uniform float uLiverFilmTime;
uniform float uLiverFlowActivity;
uniform float uLiverReliefScaleM;
${LIVER_FILM_FRAGMENT_OPTICS}
${LIVER_FILM_LEVELING}
float liverSmootherstep(float edge0, float edge1, float x) {
  float t = clamp((x - edge0) / max(1e-9, edge1 - edge0), 0.0, 1.0);
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}
float liverSmoothEffectiveDepth(out float coverage) {
  float quad = 0.28 * (dot(vLiverSmoothGradient, vLiverMetricPos) - vLiverGradDotPos);
  float hSigned = vLiverSmoothThicknessM + clamp(quad, -0.00018, 0.00018);
  float fw = min(0.00009, fwidth(hSigned) * 2.5);
  float hShifted = hSigned + fw * 0.5;
  if (hShifted <= 0.0) {
    coverage = 0.0;
    return 0.0;
  }
  float featherM = max(0.000035, fw * 1.5);
  coverage = liverSmootherstep(0.0, featherM, hShifted);
  return hShifted * coverage;
}
// Authored free-surface detail (presentation only): C2 value noise advected
// downhill along the gravity tangent. Two half-period-offset phases are
// cross-faded (flow-map scheme), so advection never shears the pattern.
float liverHash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float liverValueNoise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(mix(mix(liverHash(i), liverHash(i + vec3(1, 0, 0)), u.x),
                 mix(liverHash(i + vec3(0, 1, 0)), liverHash(i + vec3(1, 1, 0)), u.x), u.y),
             mix(mix(liverHash(i + vec3(0, 0, 1)), liverHash(i + vec3(1, 0, 1)), u.x),
                 mix(liverHash(i + vec3(0, 1, 1)), liverHash(i + vec3(1, 1, 1)), u.x), u.y), u.z);
}
float liverRippleField(vec3 p, vec3 flowDir) {
  // Roll-wave crests run across the flow; finer streaks run along it.
  float k = 1.0 / ${LIVER_FILM_VISUAL_RELIEF.rippleWavelengthMm.toFixed(4)};
  vec3 across = (p + flowDir * dot(p, flowDir) * 0.9) * k;
  vec3 along = (p - flowDir * dot(p, flowDir) * 0.6) * k * 2.3;
  return 0.62 * liverValueNoise(across) + 0.28 * liverValueNoise(along + vec3(5.2, 1.3, 9.7))
    + 0.10 * liverValueNoise(p * k * 5.1 + vec3(2.7, 8.1, 4.4));
}
float liverRipplePhase(vec3 p, vec3 flowDir, float speed) {
  float period = 1.25;
  float t0 = fract(uLiverFilmTime / period), t1 = fract(uLiverFilmTime / period + 0.5);
  float w0 = 1.0 - abs(1.0 - 2.0 * t0);
  float r0 = liverRippleField(p - flowDir * speed * period * t0, flowDir);
  float r1 = liverRippleField(p - flowDir * speed * period * t1 + vec3(13.7, 4.1, 7.9), flowDir);
  return mix(r1, r0, w0);
}
// Advected flow-field value in [-1, 1] (0 when calm); drives subtle density
// streaks in the body colour so the stream visibly travels downhill.
float liverFlowStreak = 0.0;
vec3 liverRippleGradient(float depthM, float coverage) {
  vec3 n = normalize(vLiverWorldNormal);
  vec3 g = vec3(0.0, -1.0, 0.0);
  vec3 downhill = g - dot(g, n) * n;
  float incline = length(downhill);
  vec3 flowDir = incline > 1e-4 ? downhill / incline : normalize(cross(n, vec3(1.0, 0.0, 0.0)) + vec3(1e-4));
  vec3 crossDir = normalize(cross(n, flowDir));
  // Thicker, steeper film moves faster and carries larger waves; the contact
  // rim stays calm so the meniscus highlight remains a clean curve.
  float depthWeight = smoothstep(0.00002, 0.00022, depthM) * coverage;
  float amplitude = ${LIVER_FILM_VISUAL_RELIEF.rippleAmplitudeMm.toFixed(4)} * depthWeight * uLiverFlowActivity;
  if (amplitude <= 1e-6) return vec3(0.0);
  float speed = ${LIVER_FILM_VISUAL_RELIEF.rippleSpeedMmS.toFixed(4)} * (0.35 + 0.65 * clamp(incline * 1.5, 0.0, 1.0));
  float e = 0.12;
  vec3 p = vLiverWorldPos;
  float h0 = liverRipplePhase(p, flowDir, speed);
  float hs = liverRipplePhase(p + flowDir * e, flowDir, speed);
  float hc = liverRipplePhase(p + crossDir * e, flowDir, speed);
  liverFlowStreak = clamp((h0 - 0.5) * 2.6, -1.0, 1.0) * depthWeight * uLiverFlowActivity;
  return amplitude * ((hs - h0) * flowDir + (hc - h0) * crossDir) / e;
}`)
        .replace("#include <clipping_planes_fragment>", `#include <clipping_planes_fragment>
float liverContactCoverage = 0.0;
float liverEffectiveDepthM = liverSmoothEffectiveDepth(liverContactCoverage);
if (liverContactCoverage <= 1e-5) discard;
vec3 liverRippleGradW = liverRippleGradient(liverEffectiveDepthM, liverContactCoverage);`)
        .replace("#include <roughnessmap_fragment>", `
${atlasSubstrate ? "" : "diffuseColor.rgb = vLiverSubstrateLinear;"}
vec3 liverCapsuleBaseRGB = diffuseColor.rgb;
// Optical path: whole blood is near-opaque beyond a fraction of a millimetre,
// so colour saturates quickly (only the last few µm of level set at the
// contact line stay translucent) while the geometry keeps its gradual dome.
// The refracted ray (Snell, n = 1.35) lengthens the path at oblique views.
float liverVisualReliefM = ${LIVER_FILM_VISUAL_RELIEF.maximumM.toExponential(4)} * (1.0 - exp(-liverEffectiveDepthM / ${LIVER_FILM_VISUAL_RELIEF.opticalSaturationM.toExponential(4)}));
float liverCosI = clamp(abs(dot(normalize(vLiverSmoothNormal), normalize(vViewPosition))), 0.0, 1.0);
float liverCosT = sqrt(max(0.05, 1.0 - (1.0 - liverCosI * liverCosI) / (1.35 * 1.35)));
vec4 liverOpticalStack = liverFilmOpticalLayer((liverEffectiveDepthM + liverVisualReliefM) / liverCosT * liverContactCoverage, liverCapsuleBaseRGB);
diffuseColor = vec4(mix(liverCapsuleBaseRGB, liverOpticalStack.rgb, liverContactCoverage), 1.0);
{
  // Depth cue across the rivulet: the deep, rounded core loses more light to
  // haemoglobin absorption and multiple scattering than the thin rim, so it
  // reads maroon while the rim stays scarlet. The advected flow field adds
  // gentle travelling density streaks. tanh written out for GLSL ES 1.0.
  float x = 2.0 * max(liverEffectiveDepthM, 0.0) / max(uLiverReliefScaleM, 1e-9);
  float e2 = exp(-min(x, 40.0));
  float dome = (1.0 - e2) / (1.0 + e2);
  float core = clamp(dome * (1.0 + ${LIVER_FILM_VISUAL_RELIEF.flowStreakContrast.toFixed(3)} * liverFlowStreak), 0.0, 1.0);
  float d = ${LIVER_FILM_VISUAL_RELIEF.coreDarkening.toFixed(3)};
  diffuseColor.rgb *= mix(vec3(1.0), vec3(d, d * 0.8, d * 0.85), core * liverContactCoverage);
}
#include <roughnessmap_fragment>
float liverCapsuleRough = ${atlasSubstrate ? "max(0.28, atlasSurface.roughness)" : "uLiverCapsuleRoughness"};
float liverWetRough = liverFilmMixedRoughness(max(liverEffectiveDepthM, 0.00004 * liverContactCoverage), liverCapsuleRough, roughnessFactor);
roughnessFactor = mix(liverCapsuleRough, liverWetRough, liverContactCoverage);`)
        .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
{
  vec3 capsuleNormal = normalize(vLiverCapsuleNormal);
  vec3 liquidNormal = normalize(vLiverSmoothNormal);
  vec3 rippleGradV = mat3(viewMatrix) * liverRippleGradW;
  rippleGradV -= dot(rippleGradV, liquidNormal) * liquidNormal;
  liquidNormal = normalize(liquidNormal - rippleGradV);
  // The free surface replaces the capsule wherever blood covers it; only the
  // feathered contact line blends back to the dry capsule normal.
  float normalWetWeight = liverContactCoverage;
  nonPerturbedNormal = normalize(mix(capsuleNormal, normalize(vLiverSmoothNormal), normalWetWeight));
  ${atlasSubstrate ? `capsuleNormal = atlasPerturbNormal(-vViewPosition, capsuleNormal,
    atlasSurface.heightGradientRest * ${CAPSULE_RELIEF_SCALE}, faceDirection);` : ""}
  normal = normalize(mix(capsuleNormal, liquidNormal, normalWetWeight));
}`)
        .replace("#include <lights_fragment_maps>", `#include <lights_fragment_maps>
#if defined( RE_IndirectSpecular )
  // Presentation: the capsule uses a dim environment; the liquid mirror shows it.
  radiance *= mix(1.0, ${LIVER_FILM_VISUAL_RELIEF.environmentReflectionGain.toFixed(3)}, liverContactCoverage);
#endif`)
        .replace("roughnessFactor = atlasSurface.roughness;", "")
        .replace("normal = atlasPerturbNormal(-vViewPosition, normal, atlasSurface.heightGradientRest, faceDirection);", "")
        .replace("clearcoatNormal = atlasPerturbNormal(-vViewPosition, clearcoatNormal, atlasSurface.heightGradientRest, faceDirection);", "");
    } else {
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>
attribute float liverThicknessM;
attribute vec3 liverSubstrateLinear;
attribute vec3 liverCapsuleNormal;
varying float vLiverThicknessM;
varying vec3 vLiverSubstrateLinear;
varying vec3 vLiverCapsuleNormal;`)
        .replace("#include <begin_vertex>", `#include <begin_vertex>
vLiverThicknessM = liverThicknessM;
vLiverSubstrateLinear = liverSubstrateLinear;
vLiverCapsuleNormal = normalMatrix * liverCapsuleNormal;`);
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>
varying float vLiverThicknessM;
varying vec3 vLiverSubstrateLinear;
varying vec3 vLiverCapsuleNormal;
${LIVER_FILM_FRAGMENT_OPTICS}
${LIVER_FILM_LEVELING}`)
        // Dry tissue generates neither an extra interface nor a depth write.
        .replace("#include <clipping_planes_fragment>", `#include <clipping_planes_fragment>
if (vLiverThicknessM <= 0.0) discard;`)
        .replace("#include <roughnessmap_fragment>", `
${atlasSubstrate ? "" : "diffuseColor.rgb = vLiverSubstrateLinear;"}
diffuseColor = liverFilmOpticalLayer(vLiverThicknessM, diffuseColor.rgb);
#include <roughnessmap_fragment>
roughnessFactor = liverFilmMixedRoughness(vLiverThicknessM,
  ${atlasSubstrate ? "max(0.28, atlasSurface.roughness)" : "uLiverCapsuleRoughness"}, roughnessFactor);`)
        .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
if (uLiverCapsuleReliefM > 0.0) {
  vec3 capsuleNormal = normalize(vLiverCapsuleNormal);
  nonPerturbedNormal = normalize(mix(capsuleNormal, nonPerturbedNormal, liverFilmLeveling(vLiverThicknessM)));
  ${atlasSubstrate ? `capsuleNormal = atlasPerturbNormal(-vViewPosition, capsuleNormal,
    atlasSurface.heightGradientRest * ${CAPSULE_RELIEF_SCALE}, faceDirection);` : ""}
  normal = normalize(mix(capsuleNormal, normal, liverFilmLeveling(vLiverThicknessM)));
}`)
        // Atlas/photo contributes substrate colour only. Film shape and BRDF
        // remain those of the accepted free surface, not the capsule's bump.
        .replace("roughnessFactor = atlasSurface.roughness;", "")
        .replace("normal = atlasPerturbNormal(-vViewPosition, normal, atlasSurface.heightGradientRest, faceDirection);", "")
        .replace("clearcoatNormal = atlasPerturbNormal(-vViewPosition, clearcoatNormal, atlasSurface.heightGradientRest, faceDirection);", "");
    }
  };
  material.customProgramCacheKey = () => `${baseKey.call(material)}:liver-linear-complete-stack-optics-${smoothContactOptics ? "smooth-10-dome-core" : "3"}`;
  material.needsUpdate = true;
}

function validateSurface(surface: LiverSurface) {
  const count = surface.positionsM.length / 3;
  if (!Number.isInteger(count) || surface.normals.length !== surface.positionsM.length ||
      surface.indices.length % 3 || count > 1_000_000)
    throw new RangeError("Invalid liver surface buffers");
  for (const value of surface.positionsM) if (!Number.isFinite(value)) throw new RangeError("Non-finite liver position");
  for (const value of surface.normals) if (!Number.isFinite(value)) throw new RangeError("Non-finite liver normal");
  for (const index of surface.indices) if (index >= count) throw new RangeError("Liver index outside vertex buffer");
}
function geometryFor(surface: LiverSurface) {
  validateSurface(surface);
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(Float32Array.from(surface.positionsM, value => value * MM), 3));
  geometry.setAttribute("normal", new BufferAttribute(surface.normals.slice(), 3));
  geometry.setIndex(new BufferAttribute(surface.indices.slice(), 1));
  geometry.computeBoundingSphere();
  return geometry;
}
function replaceAttribute(geometry: BufferGeometry, name: string, values: Float32Array, size = 3) {
  const old = geometry.getAttribute(name);
  if (old && old.array.length === values.length && old.itemSize === size) {
    if (old.array !== values) old.array.set(values);
    old.needsUpdate = true;
  }
  else geometry.setAttribute(name, new BufferAttribute(values, size).setUsage(DynamicDrawUsage));
}
function sourceWeights(anatomy: LiverAnatomy, geometry: LiverCutGeometry, index: number) {
  const triangle = geometry.sourceTriangles[index]!;
  const offset = triangle * 3;
  return { ids: [anatomy.surface.indices[offset]!, anatomy.surface.indices[offset + 1]!, anatomy.surface.indices[offset + 2]!],
    weights: [geometry.sourceBarycentrics[index * 3]!, geometry.sourceBarycentrics[index * 3 + 1]!,
      geometry.sourceBarycentrics[index * 3 + 2]!] };
}
function validateMapping(anatomy: LiverAnatomy, geometry: LiverCutGeometry) {
  const count = geometry.surface.positionsM.length / 3;
  if (geometry.sourceTriangles.length !== count || geometry.sourceBarycentrics.length !== count * 3)
    throw new RangeError("Cut surface requires canonical triangle and barycentric mappings");
  for (let i = 0; i < count; i++) {
    if (geometry.sourceTriangles[i]! >= anatomy.surface.indices.length / 3) throw new RangeError("Invalid source triangle");
    const w = geometry.sourceBarycentrics.subarray(i * 3, i * 3 + 3);
    if ([...w].some(value => !Number.isFinite(value) || value < -1e-9 || value > 1 + 1e-9) ||
        Math.abs(w[0]! + w[1]! + w[2]! - 1) > 1e-9) throw new RangeError("Invalid source barycentric coordinates");
  }
}

/** Canonical P1 film restricted to retained capsule triangles. The volume
 * integral uses unoffset physical area, matching the solver's thin-film model;
 * the displayed offset surface is not claimed to be an exact extruded solid.
 */
export function createLiverFilmCache(anatomy: LiverAnatomy, cut: LiverCutGeometry, substrateRGB: Float32Array) {
  validateMapping(anatomy, cut);
  const count = cut.surface.positionsM.length / 3, canonicalCount = anatomy.surface.positionsM.length / 3;
  if (substrateRGB.length !== count * 3) throw new RangeError("Invalid liver film substrate");
  const positions = Float32Array.from(cut.surface.positionsM, value => value * MM), colours = new Float32Array(count * 4);
  const ids = new Uint32Array(count * 3), singleton = new Int32Array(count).fill(-1);
  const displacementNormals = new Float64Array(count * 3), normals = new Float32Array(count * 3),
    thicknessM = new Float32Array(count);
  const normalGroups = new Uint32Array(count), groupIds = new Map<string, number>();
  const canonicalSubstrate = new Float32Array(canonicalCount * 3), areaCoefficients = new Float64Array(canonicalCount);
  for (let i = 0; i < count; i++) {
    const source = sourceWeights(anatomy, cut, i); ids.set(source.ids, i * 3);
    // Match physical contact exactly: normalize the P1 canonical source normal
    // before applying thickness. Shading normals below are independently
    // reconstructed from the resulting displaced facets.
    let nx = 0, ny = 0, nz = 0;
    for (let corner = 0; corner < 3; corner++) {
      const id = source.ids[corner]!, weight = source.weights[corner]!;
      nx += anatomy.surface.normals[id * 3]! * weight;
      ny += anatomy.surface.normals[id * 3 + 1]! * weight;
      nz += anatomy.surface.normals[id * 3 + 2]! * weight;
    }
    const length = Math.hypot(nx, ny, nz);
    if (!(length > 1e-12)) throw new RangeError("Degenerate liver film displacement normal");
    displacementNormals.set([nx / length, ny / length, nz / length], i * 3);
    // Weld only vertices with the same canonical support. This smooths shading
    // across triangulation seams without joining separate anatomical sheets or
    // changing the physical grid, offsets, or thickness support.
    const key = source.ids.map((id, corner) => ({ id, weight: source.weights[corner]! }))
      .filter(item => item.weight > 1e-12).sort((a, b) => a.id - b.id)
      .map(item => `${item.id}:${Math.round(item.weight * 1e12)}`).join("/");
    let group = groupIds.get(key);
    if (group === undefined) { group = groupIds.size; groupIds.set(key, group); }
    normalGroups[i] = group;
    const corner = source.weights.findIndex(weight => weight === 1);
    if (corner >= 0 && source.weights.every((weight, j) => j === corner || weight === 0)) {
      singleton[i] = source.ids[corner]!;
      for (let axis = 0; axis < 3; axis++) canonicalSubstrate[singleton[i]! * 3 + axis] = substrateRGB[i * 3 + axis]!;
    }
  }
  const groupCount = groupIds.size;
  const groupBasePosM = new Float64Array(groupCount * 3);
  const groupBaseNormal = new Float64Array(groupCount * 3);
  for (let i = 0; i < count; i++) {
    const g3 = normalGroups[i]! * 3, i3 = i * 3;
    for (let axis = 0; axis < 3; axis++) {
      groupBasePosM[g3 + axis] = cut.surface.positionsM[i3 + axis]!;
      groupBaseNormal[g3 + axis] = displacementNormals[i3 + axis]!;
    }
  }
  const adj = Array.from({ length: groupCount }, () => new Set<number>());
  const a = new Vector3(), b = new Vector3(), c = new Vector3();
  for (let i = 0; i < cut.surface.indices.length; i += 3) {
    const ia = cut.surface.indices[i]!, ib = cut.surface.indices[i + 1]!, ic = cut.surface.indices[i + 2]!;
    a.fromArray(cut.surface.positionsM, ia * 3); b.fromArray(cut.surface.positionsM, ib * 3); c.fromArray(cut.surface.positionsM, ic * 3);
    const area = b.sub(a).cross(c.sub(a)).length() * .5;
    for (const vertex of [ia, ib, ic]) for (let corner = 0; corner < 3; corner++) {
      const original = ids[vertex * 3 + corner]!;
      areaCoefficients[original] = areaCoefficients[original]! + area / 3 * cut.sourceBarycentrics[vertex * 3 + corner]!;
    }
    const ga = normalGroups[ia]!, gb = normalGroups[ib]!, gc = normalGroups[ic]!;
    if (ga !== gb) { adj[ga]!.add(gb); adj[gb]!.add(ga); }
    if (gb !== gc) { adj[gb]!.add(gc); adj[gc]!.add(gb); }
    if (gc !== ga) { adj[gc]!.add(ga); adj[ga]!.add(gc); }
  }
  const groupNeighborOffsets = new Uint32Array(groupCount + 1);
  let totalDirected = 0;
  for (let g = 0; g < groupCount; g++) {
    groupNeighborOffsets[g] = totalDirected;
    totalDirected += adj[g]!.size;
  }
  groupNeighborOffsets[groupCount] = totalDirected;
  const groupNeighborIndices = new Uint32Array(totalDirected);
  const groupNeighborWeights = new Float32Array(totalDirected);
  const groupGradCoeffs = new Float32Array(totalDirected * 3);
  for (let g = 0; g < groupCount; g++) {
    const start = groupNeighborOffsets[g]!, g3 = g * 3;
    const gx = groupBasePosM[g3]!, gy = groupBasePosM[g3 + 1]!, gz = groupBasePosM[g3 + 2]!;
    const nx = groupBaseNormal[g3]!, ny = groupBaseNormal[g3 + 1]!, nz = groupBaseNormal[g3 + 2]!;
    let offset = start, weightSum = 0;
    for (const n of adj[g]!) {
      groupNeighborIndices[offset] = n;
      const n3 = n * 3;
      const dx = groupBasePosM[n3]! - gx, dy = groupBasePosM[n3 + 1]! - gy, dz = groupBasePosM[n3 + 2]! - gz;
      const dist = Math.max(1e-5, Math.hypot(dx, dy, dz));
      const w = 1 / dist;
      groupNeighborWeights[offset] = w;
      weightSum += w;
      offset++;
    }
    if (weightSum > 0) {
      for (let e = start; e < offset; e++) {
        const wNorm = groupNeighborWeights[e]! / weightSum;
        groupNeighborWeights[e] = wNorm;
        const n3 = groupNeighborIndices[e]! * 3;
        const dx = groupBasePosM[n3]! - gx, dy = groupBasePosM[n3 + 1]! - gy, dz = groupBasePosM[n3 + 2]! - gz;
        const d2 = Math.max(1e-10, dx * dx + dy * dy + dz * dz);
        const dotN = dx * nx + dy * ny + dz * nz;
        const tx = dx - dotN * nx, ty = dy - dotN * ny, tz = dz - dotN * nz;
        const scale = 2 * wNorm / d2, e3 = e * 3;
        groupGradCoeffs[e3] = tx * scale;
        groupGradCoeffs[e3 + 1] = ty * scale;
        groupGradCoeffs[e3 + 2] = tz * scale;
      }
    }
  }
  const capsuleNormals = Float32Array.from(displacementNormals);
  return { positions, colours, ids, singleton, canonicalSubstrate, areaCoefficients, substrateRGB, thicknessM,
    basePositions: cut.surface.positionsM, displacementNormals, capsuleNormals,
    normals, weights: cut.sourceBarycentrics,
    indices: cut.surface.indices, normalGroups,
    groupCount, groupBaseNormal, groupNeighborOffsets, groupNeighborIndices, groupNeighborWeights, groupGradCoeffs,
    groupH: new Float64Array(groupCount), groupHNext: new Float64Array(groupCount),
    groupGrad: new Float64Array(groupCount * 3), groupGradNext: new Float64Array(groupCount * 3),
    smoothThicknessM: new Float32Array(count), smoothPositions: Float32Array.from(positions),
    smoothNormals: Float32Array.from(capsuleNormals), smoothGradient: new Float32Array(count * 3),
    groupNormalSums: new Float64Array(groupIds.size * 3), groupNormalChanged: new Uint8Array(groupIds.size),
    faceCrosses: new Float64Array(cut.surface.indices.length),
    vertexPositionChanged: new Uint8Array(count),
    canonicalDepth: new Float64Array(canonicalCount).fill(-1), vertexDepth: new Float64Array(count).fill(-1),
    canonicalRGBA: new Float32Array(canonicalCount * 4), canonicalChanged: new Uint8Array(canonicalCount),
    oxygenation: NaN, derived: null as { wetVertices: number; maximumDepthM: number; volumeM3: number } | null };
}
type FilmCache = ReturnType<typeof createLiverFilmCache>;
export function updateLiverFilmCache(cache: FilmCache, film: Pick<LiverFilmSnapshot, "depthM">, oxygenation: number) {
  const depth = film.depthM;
  if (depth.length !== cache.canonicalDepth.length || !Number.isFinite(oxygenation) || oxygenation < 0 || oxygenation > 1)
    throw new RangeError("Invalid accepted liver film");
  // Validate before touching any renderer-owned accepted cache.
  let depthChanged = false;
  for (let i = 0; i < depth.length; i++) {
    const h = depth[i]!;
    if (!Number.isFinite(h) || h < 0) throw new RangeError("Invalid accepted liver film");
    if (h !== cache.canonicalDepth[i]) depthChanged = true;
  }
  const recolour = oxygenation !== cache.oxygenation;
  if (!depthChanged && !recolour && cache.derived) return {
    positions: cache.positions, colours: cache.colours, normals: cache.normals,
    capsuleNormals: cache.capsuleNormals, thicknessM: cache.thicknessM,
    smoothPositions: cache.smoothPositions, smoothNormals: cache.smoothNormals,
    smoothThicknessM: cache.smoothThicknessM, smoothGradient: cache.smoothGradient,
    ...cache.derived, positionChanged: false, colourChanged: false,
  };
  let volumeM3 = 0, wetVertices = 0, maximum = 0, positionChanged = false, colourChanged = false;
  for (let i = 0; i < depth.length; i++) {
    const h = depth[i]!;
    volumeM3 += h * cache.areaCoefficients[i]!;
    const changed = recolour || h !== cache.canonicalDepth[i]!;
    cache.canonicalChanged[i] = changed ? 1 : 0;
    if (changed) {
      if (h === 0) cache.canonicalRGBA.fill(0, i * 4, i * 4 + 4);
      else cache.canonicalRGBA.set(liverFilmOpticalRGBA(h, oxygenation,
        [cache.canonicalSubstrate[i * 3]!, cache.canonicalSubstrate[i * 3 + 1]!, cache.canonicalSubstrate[i * 3 + 2]!]), i * 4);
    }
    cache.canonicalDepth[i] = h;
  }
  for (let i = 0; i < cache.vertexDepth.length; i++) {
    const singleton = cache.singleton[i]!, offset = i * 3;
    const h = singleton >= 0 ? depth[singleton]! : Math.max(0,
      depth[cache.ids[offset]!]! * cache.weights[offset]! +
      depth[cache.ids[offset + 1]!]! * cache.weights[offset + 1]! +
      depth[cache.ids[offset + 2]!]! * cache.weights[offset + 2]!);
    if (h > 0) wetVertices++; maximum = Math.max(maximum, h);
    const changed = h !== cache.vertexDepth[i]!;
    cache.vertexPositionChanged[i] = changed ? 1 : 0;
    if (changed) cache.thicknessM[i] = h;
    if (changed) for (let axis = 0; axis < 3; axis++)
      cache.positions[offset + axis] = (cache.basePositions[offset + axis]! + cache.displacementNormals[offset + axis]! * h) * MM;
    if (changed) positionChanged = true;
    if (singleton >= 0 ? cache.canonicalChanged[singleton] : changed || recolour) {
      if (h === 0) cache.colours.fill(0, i * 4, i * 4 + 4);
      else if (singleton >= 0) {
        for (let channel = 0; channel < 4; channel++) cache.colours[i * 4 + channel] = cache.canonicalRGBA[singleton * 4 + channel]!;
      } else cache.colours.set(liverFilmOpticalRGBA(h, oxygenation,
        [cache.substrateRGB[offset]!, cache.substrateRGB[offset + 1]!, cache.substrateRGB[offset + 2]!]), i * 4);
      colourChanged = true;
    }
    cache.vertexDepth[i] = h;
  }
  if (positionChanged) {
    cache.groupNormalChanged.fill(0);
    for (let face = 0; face < cache.indices.length; face += 3) {
      const ia = cache.indices[face]!, ib = cache.indices[face + 1]!, ic = cache.indices[face + 2]!;
      if (!(cache.vertexPositionChanged[ia] || cache.vertexPositionChanged[ib] || cache.vertexPositionChanged[ic])) continue;
      const ax = cache.positions[ib * 3]! - cache.positions[ia * 3]!,
        ay = cache.positions[ib * 3 + 1]! - cache.positions[ia * 3 + 1]!,
        az = cache.positions[ib * 3 + 2]! - cache.positions[ia * 3 + 2]!;
      const bx = cache.positions[ic * 3]! - cache.positions[ia * 3]!,
        by = cache.positions[ic * 3 + 1]! - cache.positions[ia * 3 + 1]!,
        bz = cache.positions[ic * 3 + 2]! - cache.positions[ia * 3 + 2]!;
      const cross = [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
      for (const vertex of [ia, ib, ic]) {
        const group = cache.normalGroups[vertex]!; cache.groupNormalChanged[group] = 1;
        for (let axis = 0; axis < 3; axis++)
          cache.groupNormalSums[group * 3 + axis] = cache.groupNormalSums[group * 3 + axis]! +
            cross[axis]! - cache.faceCrosses[face + axis]!;
      }
      cache.faceCrosses.set(cross, face);
    }
    for (let i = 0; i < cache.normalGroups.length; i++) {
      const group = cache.normalGroups[i]!;
      if (!cache.groupNormalChanged[group]) continue;
      const nx = cache.groupNormalSums[group * 3]!, ny = cache.groupNormalSums[group * 3 + 1]!,
        nz = cache.groupNormalSums[group * 3 + 2]!, length = Math.hypot(nx, ny, nz);
      for (let axis = 0; axis < 3; axis++)
        cache.normals[i * 3 + axis] = length > 1e-20 ? cache.groupNormalSums[group * 3 + axis]! / length
          : cache.displacementNormals[i * 3 + axis]!;
    }
    const count = cache.vertexDepth.length, G = cache.groupCount;
    if (wetVertices === 0) {
      cache.smoothThicknessM.fill(0);
      cache.smoothPositions.set(cache.positions);
      cache.smoothNormals.set(cache.capsuleNormals);
      cache.smoothGradient.fill(0);
    } else {
      cache.groupH.fill(0);
      for (let i = 0; i < count; i++) {
        const g = cache.normalGroups[i]!, h = cache.thicknessM[i]!;
        if (h > cache.groupH[g]!) cache.groupH[g] = h;
      }
      const offsets = cache.groupNeighborOffsets, neighbors = cache.groupNeighborIndices, weights = cache.groupNeighborWeights;
      for (let pass = 0; pass < 10; pass++) {
        const src = pass % 2 === 0 ? cache.groupH : cache.groupHNext;
        const dst = pass % 2 === 0 ? cache.groupHNext : cache.groupH;
        const dilate = pass < 3;
        for (let g = 0; g < G; g++) {
          const start = offsets[g]!, end = offsets[g + 1]!, h0 = src[g]!;
          let avg = 0;
          for (let e = start; e < end; e++) avg += weights[e]! * src[neighbors[e]!]!;
          dst[g] = dilate ? Math.max(0.62 * h0 + 0.38 * avg, 0.55 * avg) : 0.42 * h0 + 0.58 * avg;
        }
      }
      let maxSmooth = 0;
      for (let g = 0; g < G; g++) if (cache.groupH[g]! > maxSmooth) maxSmooth = cache.groupH[g]!;
      const scale = maxSmooth > 1e-12 ? maximum / maxSmooth : 1;
      const contactCutoffM = liverFilmContactCutoffM(maximum);
      for (let g = 0; g < G; g++) cache.groupH[g] = cache.groupH[g]! * scale - contactCutoffM;
      const gradCoeffs = cache.groupGradCoeffs;
      for (let g = 0; g < G; g++) {
        const start = offsets[g]!, end = offsets[g + 1]!, h0 = cache.groupH[g]!, g3 = g * 3;
        let gx = 0, gy = 0, gz = 0;
        for (let e = start; e < end; e++) {
          const dh = cache.groupH[neighbors[e]!]! - h0, e3 = e * 3;
          gx += gradCoeffs[e3]! * dh;
          gy += gradCoeffs[e3 + 1]! * dh;
          gz += gradCoeffs[e3 + 2]! * dh;
        }
        cache.groupGrad[g3] = gx; cache.groupGrad[g3 + 1] = gy; cache.groupGrad[g3 + 2] = gz;
      }
      for (let pass = 0; pass < 2; pass++) {
        const gSrc = pass % 2 === 0 ? cache.groupGrad : cache.groupGradNext;
        const gDst = pass % 2 === 0 ? cache.groupGradNext : cache.groupGrad;
        for (let g = 0; g < G; g++) {
          const start = offsets[g]!, end = offsets[g + 1]!, g3 = g * 3;
          let ax = 0, ay = 0, az = 0;
          for (let e = start; e < end; e++) {
            const w = weights[e]!, n3 = neighbors[e]! * 3;
            ax += w * gSrc[n3]!; ay += w * gSrc[n3 + 1]!; az += w * gSrc[n3 + 2]!;
          }
          const nx = cache.groupBaseNormal[g3]!, ny = cache.groupBaseNormal[g3 + 1]!, nz = cache.groupBaseNormal[g3 + 2]!;
          const rx = 0.45 * gSrc[g3]! + 0.55 * ax, ry = 0.45 * gSrc[g3 + 1]! + 0.55 * ay, rz = 0.45 * gSrc[g3 + 2]! + 0.55 * az;
          const dotN = rx * nx + ry * ny + rz * nz;
          gDst[g3] = rx - dotN * nx; gDst[g3 + 1] = ry - dotN * ny; gDst[g3 + 2] = rz - dotN * nz;
        }
      }
      // Visual relief only (never mass, coverage, or physical offsets): the
      // solver's P1 depth is a cell average diluted over coarse dual cells, so
      // a real 1–3 mm rivulet would read as a painted stain. Map the smoothed
      // signed level set through a dome profile h_vis = max·tanh(h/s), with s
      // tied to the current peak so the cross-section stays rounded rather than
      // saturating into a slab, and shade with the exact height-field normals
      // n' = normalize(n − ∇h_vis). The rim curves down like a meniscus.
      const VISUAL_RELIEF_MAX_M = LIVER_FILM_VISUAL_RELIEF.maximumM, VISUAL_RELIEF_SCALE_M = liverFilmReliefScaleM(maximum);
      const MAX_RELIEF_SLOPE = 1.35;
      for (let i = 0; i < count; i++) {
        const g = cache.normalGroups[i]!, g3 = g * 3, i3 = i * 3;
        const phi = cache.groupH[g]!, hPos = Math.max(0, phi);
        const dome = Math.tanh(hPos / VISUAL_RELIEF_SCALE_M);
        const hVis = VISUAL_RELIEF_MAX_M * dome;
        const dhVis = VISUAL_RELIEF_MAX_M / VISUAL_RELIEF_SCALE_M * (1 - dome * dome);
        cache.smoothThicknessM[i] = phi;
        for (let axis = 0; axis < 3; axis++) {
          cache.smoothPositions[i3 + axis] = (cache.basePositions[i3 + axis]! + cache.displacementNormals[i3 + axis]! * (hPos + hVis)) * MM;
          cache.smoothGradient[i3 + axis] = cache.groupGrad[g3 + axis]!;
        }
        // Keep the slope at the contact line (phi→0⁺) so the rim stays rounded.
        const slopeGain = phi > -VISUAL_RELIEF_SCALE_M ? (phi > 0 ? dhVis : VISUAL_RELIEF_MAX_M / VISUAL_RELIEF_SCALE_M) : 0;
        let gx = cache.groupGrad[g3]! * slopeGain, gy = cache.groupGrad[g3 + 1]! * slopeGain, gz = cache.groupGrad[g3 + 2]! * slopeGain;
        const slope = Math.hypot(gx, gy, gz);
        if (slope > MAX_RELIEF_SLOPE) { const s = MAX_RELIEF_SLOPE / slope; gx *= s; gy *= s; gz *= s; }
        const cnx = cache.displacementNormals[i3]! - gx;
        const cny = cache.displacementNormals[i3 + 1]! - gy;
        const cnz = cache.displacementNormals[i3 + 2]! - gz;
        const len = Math.hypot(cnx, cny, cnz);
        cache.smoothNormals[i3] = len > 1e-12 ? cnx / len : cache.capsuleNormals[i3]!;
        cache.smoothNormals[i3 + 1] = len > 1e-12 ? cny / len : cache.capsuleNormals[i3 + 1]!;
        cache.smoothNormals[i3 + 2] = len > 1e-12 ? cnz / len : cache.capsuleNormals[i3 + 2]!;
      }
    }
  }
  cache.oxygenation = oxygenation;
  cache.derived = { wetVertices, maximumDepthM: maximum, volumeM3 };
  return { positions: cache.positions, colours: cache.colours, normals: cache.normals,
    capsuleNormals: cache.capsuleNormals, thicknessM: cache.thicknessM,
    smoothPositions: cache.smoothPositions, smoothNormals: cache.smoothNormals,
    smoothThicknessM: cache.smoothThicknessM, smoothGradient: cache.smoothGradient,
    wetVertices, maximumDepthM: maximum,
    volumeM3, positionChanged, colourChanged };
}
export function liverFilmGeometry(anatomy: LiverAnatomy, cut: LiverCutGeometry,
  film: Pick<LiverFilmSnapshot, "depthM">, substrateRGB: Float32Array, oxygenation: number) {
  return updateLiverFilmCache(createLiverFilmCache(anatomy, cut, substrateRGB), film, oxygenation);
}

/** Render accepted state only. No camera handler, draw, or recorder lease
 * integrates blood, opens a vessel, or mutates anatomy/solver-owned buffers.
 */
export class LiverRenderer {
  readonly canvas: HTMLCanvasElement;
  private readonly gpu: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(35, 1, .1, 10_000);
  private readonly controls: OrbitControls;
  private readonly owned = new Set<Disposable>();
  private readonly liver: Mesh<BufferGeometry, MeshPhysicalMaterial>;
  private readonly cavity: Mesh<BufferGeometry, MeshPhysicalMaterial>;
  private readonly film: Mesh<BufferGeometry, MeshPhysicalMaterial>;
  private readonly filmTransportTexture: DataTexture;
  private filmMaterialDefinition: AtlasMaterialDefinition | null = null;
  private capsuleReliefM = 0;
  private readonly guides: LineSegments<BufferGeometry, LineBasicMaterial>;
  private readonly marker: Mesh<RingGeometry, MeshBasicMaterial>;
  /** Display-only outline of the vessel a cut at the hovered site would open. */
  private readonly vesselHighlight: Mesh<CylinderGeometry, MeshBasicMaterial>;
  /** Constant screen-size reticle around the true-scale cut ring, so millimetre cuts stay findable when zoomed out. */
  private readonly reticle: Mesh<RingGeometry, MeshBasicMaterial>;
  private cutPreview: LiverRendererCutPreview | null = null;
  /** Non-primary mouse buttons in cut mode orbit the camera; they never cut. */
  private readonly orbitPointers = new Set<number>();
  private readonly jets: Mesh<BufferGeometry, MeshPhysicalMaterial>;
  private drops: InstancedMesh | undefined;
  private readonly dropGeometry: SphereGeometry;
  private readonly dropMaterial: MeshPhysicalMaterial;
  private readonly dropRadiusCorrection: number;
  private dropCapacity = 0;
  private readonly keyLight: DirectionalLight;
  private readonly cameraLight: SpotLight;
  private readonly operatingLight: RectAreaLight;
  private readonly operatingTarget = new Vector3();
  private readonly operatingNormal = new Vector3();
  private readonly ray = new Raycaster();
  private readonly pointer = new Vector2();
  private readonly center: Vector3;
  private readonly radius: number;
  private readonly collectionFloor: Mesh;
  private readonly collectorFilm: Mesh<BufferGeometry, MeshPhysicalMaterial>;
  private readonly collectorWalls: Mesh<BoxGeometry, MeshStandardMaterial>[] = [];
  private collectorDomain: DryCollectorDomain | null = null;
  private collectorVolume = 0;
  private collectorAcceptedVolume = 0;
  private readonly attachedRunoff = new Map<string, AttachedDisplay>();
  private attachedAcceptedVolume = 0;
  private attachedMeshVolume = 0;
  private attachedMaximumRelativeError = 0;
  private attachedUnresolvedVolume = 0;
  private attachedUnresolvedBound = 0;
  private attachedUnresolvedCount = 0;
  private sourceDropCount = 0;
  private runoffDropCount = 0;
  private runoffDropVolume = 0;
  private readonly homeDirection = new Vector3(.4, .25, 1).normalize();
  private observer: ResizeObserver | undefined;
  private recording: ReturnType<typeof registerSceneRecordingSource> | undefined;
  private detachAbort: (() => void) | undefined;
  private materialDefinition: AtlasMaterialDefinition | null;
  private photo: PhotoDetail | null = null;
  private photoState: "loading" | "loaded" | "unavailable" = "loading";
  private cutGeometry: LiverCutGeometry;
  private substrateRGB: Float32Array;
  private filmCache: FilmCache;
  private wounds: LiverWound[] = [];
  private frame: LiverFlowSnapshot | undefined;
  private appearance: LiverAppearance = { ...DEFAULT_APPEARANCE };
  private mode: "orbit" | "cut" = "orbit";
  private cutSettings = { radiusM: .001, depthM: .001 };
  private selected: LiverSurfacePick | null = null;
  private selectedTargetId: string | null = null;
  private gesture: Gesture | null = null;
  private readonly downPointers = new Set<number>();
  private multiTouchBlocked = false;
  private hoverKey = "";
  private disposed = false;
  private lost = false;
  private dirty = true;
  private time = 0;
  private filmVolume = 0;
  private filmMaximum = 0;
  private wetVertices = 0;
  private jetVolume = 0;
  private dropVolume = 0;
  private acceptedDrops: DropletGeometryInput[] = [];
  private jetThickness = new Float32Array(0);
  private ligamentCount = 0;

  constructor(private readonly host: HTMLElement, private readonly options: LiverRendererOptions) {
    try {
      validateSurface(options.anatomy.surface);
      this.cutGeometry = buildLiverCutGeometry(options.anatomy, []);
      validateMapping(options.anatomy, this.cutGeometry);
      this.materialDefinition = readAtlasMaterial(options.anatomy.organ, { organs: [options.anatomy.organ] });
      this.gpu = new WebGLRenderer({ antialias: true, alpha: false });
      this.canvas = this.gpu.domElement;
      this.canvas.tabIndex = 0;
      this.canvas.style.cssText = "display:block;width:100%;height:100%;touch-action:none";
      this.canvas.setAttribute("aria-label", "Liver bleeding scene. Orbit mode: drag or use arrows to rotate, plus or minus to zoom. Cut mode: click or tap once; dragging never cuts; right-drag rotates and scrolling zooms. Escape cancels. Home restores the camera.");
      host.appendChild(this.canvas);
      const bounds = new Box3();
      for (let i = 0; i < options.anatomy.surface.positionsM.length; i += 3)
        bounds.expandByPoint(new Vector3().fromArray(options.anatomy.surface.positionsM, i).multiplyScalar(MM));
      const sphere = bounds.getBoundingSphere(new Sphere()); this.center = sphere.center; this.radius = sphere.radius;
      if (!Number.isFinite(this.radius) || this.radius <= 0) throw new RangeError("Degenerate liver bounds");
      this.gpu.outputColorSpace = SRGBColorSpace; this.gpu.toneMapping = ACESFilmicToneMapping;
      this.gpu.shadowMap.enabled = true; this.gpu.shadowMap.type = PCFShadowMap;
      this.scene.background = new Color("#151e24");
      this.controls = new OrbitControls(this.camera, this.canvas);
      this.controls.enableDamping = false; this.controls.target.copy(this.center);
      this.controls.minDistance = this.radius * .25; this.controls.maxDistance = this.radius * 15;
      this.liver = new Mesh(this.own(geometryFor(this.cutGeometry.surface)), this.own(new MeshPhysicalMaterial({
        color: options.anatomy.organ.color, roughness: .36, ior: CAPSULE_IOR, clearcoat: 0, side: FrontSide,
      })));
      this.liver.castShadow = this.liver.receiveShadow = true;
      this.cavity = new Mesh(this.own(geometryFor(this.cutGeometry.cavity)), this.own(new MeshPhysicalMaterial({
        color: new Color().setRGB(.19, .065, .055), roughness: .38, ior: CAPSULE_IOR, clearcoat: 0, side: FrontSide,
      })));
      this.cavity.castShadow = this.cavity.receiveShadow = true;
      this.film = new Mesh(this.own(new BufferGeometry()), this.own(new MeshPhysicalMaterial({
        color: 0xffffff, vertexColors: false, roughness: .038, ior: 1.35, metalness: 0,
        transparent: false, depthWrite: true, side: FrontSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
      })));
      this.film.receiveShadow = true;
      this.filmTransportTexture = this.own(new DataTexture(liverFilmTransportTextureData(this.appearance.oxygenationFraction),
        APPEARANCE_THICKNESS_COUNT, 2, RGBAFormat, FloatType));
      this.filmTransportTexture.minFilter = this.filmTransportTexture.magFilter = NearestFilter;
      this.filmTransportTexture.generateMipmaps = false; this.filmTransportTexture.needsUpdate = true;
      this.film.visible = false; this.film.renderOrder = 1;
      this.guides = new LineSegments(this.own(new BufferGeometry()), this.own(new LineBasicMaterial({
        color: "#c39b71", transparent: true, opacity: .7, depthTest: true, depthWrite: false,
      })));
      this.marker = new Mesh(this.own(new RingGeometry(.84, 1, 64)), this.own(new MeshBasicMaterial({
        color: LIVER_CUT_PREVIEW_COLOURS.idle, transparent: true, opacity: .9, depthTest: true, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      })));
      this.marker.visible = false; this.marker.renderOrder = 3;
      // Drawn without depth test so the targeted subsurface vessel reads through the capsule.
      this.vesselHighlight = new Mesh(this.own(new CylinderGeometry(1, 1, 1, 16, 1, false)), this.own(new MeshBasicMaterial({
        color: LIVER_CUT_PREVIEW_COLOURS.vessel, transparent: true, opacity: .75, depthTest: false, depthWrite: false,
      })));
      this.vesselHighlight.visible = false; this.vesselHighlight.renderOrder = 4;
      this.reticle = new Mesh(this.own(new RingGeometry(.86, 1, 48)), this.own(new MeshBasicMaterial({
        color: LIVER_CUT_PREVIEW_COLOURS.idle, transparent: true, opacity: .6, depthTest: false, depthWrite: false,
      })));
      this.reticle.visible = false; this.reticle.renderOrder = 5;
      this.jets = new Mesh(this.own(new BufferGeometry()), this.own(new MeshPhysicalMaterial({
        color: 0xffffff, vertexColors: true, roughness: .045, ior: 1.35, metalness: 0,
      })));
      this.jets.visible = false; this.jets.castShadow = true;
      this.dropGeometry = this.own(new SphereGeometry(1, 20, 12));
      const unitVolume = Math.abs(closedTriangleVolumeM3(this.dropGeometry.attributes.position!.array, this.dropGeometry.index!.array)) * 1e9;
      this.dropRadiusCorrection = Math.cbrt((4 * Math.PI / 3) / unitVolume);
      this.dropMaterial = this.own(new MeshPhysicalMaterial({ color: 0xffffff, roughness: .045, ior: 1.35 }));
      this.scene.add(this.liver, this.cavity, this.film, this.guides, this.marker, this.vesselHighlight, this.reticle, this.jets);
      this.collectionFloor = new Mesh(this.own(new PlaneGeometry(1, 1)),
        this.own(new MeshStandardMaterial({ color: "#56616a", roughness: .65 })));
      this.collectionFloor.rotation.x = -Math.PI / 2;
      this.collectionFloor.position.set(this.center.x, liverCollectionPlaneYM(options.anatomy.surface) * MM, this.center.z);
      // Domain comes from the accepted collector snapshot. No independently
      // inferred display floor extends beyond the actual closed-wall solver.
      this.collectionFloor.visible = false;
      this.collectionFloor.receiveShadow = true; this.scene.add(this.collectionFloor);
      this.collectorFilm = new Mesh(this.own(new BufferGeometry()), this.own(new MeshPhysicalMaterial({
        color: 0xffffff, roughness: .045, ior: 1.35, side: FrontSide,
        polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
      })));
      installLiverFilmOptics(this.collectorFilm.material, this.filmTransportTexture, false, 0, .65);
      this.collectorFilm.visible = false; this.collectorFilm.receiveShadow = true;
      this.collectorFilm.renderOrder = 1; this.scene.add(this.collectorFilm);
      const wallGeometry = this.own(new BoxGeometry(1, 1, 1));
      const wallMaterial = this.own(new MeshStandardMaterial({ color: "#56616a", roughness: .65 }));
      for (let i = 0; i < 4; i++) {
        const wall = new Mesh(wallGeometry, wallMaterial);
        wall.visible = false; wall.castShadow = wall.receiveShadow = true;
        this.collectorWalls.push(wall); this.scene.add(wall);
      }
      this.keyLight = new DirectionalLight(0xffffff, 2.2);
      this.keyLight.position.copy(this.center).add(new Vector3(-1.3, 2, 1).multiplyScalar(this.radius));
      this.keyLight.target.position.copy(this.center); this.keyLight.castShadow = true;
      this.keyLight.shadow.mapSize.set(1024, 1024);
      Object.assign(this.keyLight.shadow.camera, { left: -this.radius * 1.3, right: this.radius * 1.3,
        top: this.radius * 1.3, bottom: -this.radius * 1.3, near: this.radius * .05, far: this.radius * 8 });
      this.keyLight.shadow.normalBias = this.radius * 2.6 / 1024; this.keyLight.shadow.bias = -1 / 16_777_216;
      this.own(this.keyLight.shadow);
      this.cameraLight = new SpotLight(0xffffff,
        relativeCameraLightPower(this.radius * 3.7 / MM, CAMERA_IRRADIANCE), 0, Math.PI / 4, .7, 2);
      initializeLiverAreaLightUniforms();
      const panel = LIVER_OPERATING_PANEL, projectedAngle = rectangularEmitterProjectedSolidAngle(
        panel.widthM, panel.heightM, panel.workingDistanceM);
      this.operatingLight = new RectAreaLight(0xffffff, panel.referenceRelativeIrradiance / projectedAngle,
        panel.widthM * MM, panel.heightM * MM);
      this.operatingLight.visible = false;
      this.scene.add(this.keyLight, this.keyLight.target, this.cameraLight, this.cameraLight.target, this.operatingLight);
      this.substrateRGB = this.prepareTissue(this.cutGeometry, this.liver.geometry);
      this.filmCache = createLiverFilmCache(options.anatomy, this.cutGeometry, this.substrateRGB);
      const room = new RoomEnvironment();
      let generator: PMREMGenerator | undefined;
      try {
        generator = new PMREMGenerator(this.gpu);
        this.scene.environment = this.own<WebGLRenderTarget>(generator.fromScene(room, .04)).texture;
      } finally { try { room.dispose(); } finally { generator?.dispose(); } }
      this.makeGuide();
      this.controls.addEventListener("change", this.onCameraChange);
      for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "lostpointercapture"] as const)
        this.canvas.addEventListener(type, this.pointerEvent, true);
      this.canvas.addEventListener("pointerleave", this.pointerLeave);
      this.canvas.addEventListener("keydown", this.key, true);
      this.canvas.addEventListener("wheel", this.wheel, { capture: true, passive: false });
      this.canvas.addEventListener("blur", this.blur);
      this.canvas.addEventListener("webglcontextlost", this.contextLost);
      window.addEventListener("blur", this.blur);
      this.recording = registerSceneRecordingSource({ renderer: this.gpu, camera: this.camera, host,
        label: "Liver bleeding experiment", draw: () => this.render(), available: () => !this.disposed && !this.lost });
      const prepare = this.recording.source.prepare.bind(this.recording.source);
      this.recording.source.prepare = request => {
        this.cancelGesture();
        const lease = prepare(request); let restored = false;
        const detach = () => { request.signal.removeEventListener("abort", restore); this.detachAbort = undefined; };
        const restore = () => { if (restored) return; restored = true; detach(); lease.restore(); this.resize(); };
        this.detachAbort = detach; request.signal.addEventListener("abort", restore, { once: true });
        return { restore };
      };
      this.observer = new ResizeObserver(this.resize); this.observer.observe(host);
      this.resize(); this.home(); this.applyLighting();
      if (this.materialDefinition) void photoDetailFor(options.anatomy.organ.id).then(detail => {
        if (this.disposed) return;
        this.photo = detail; this.photoState = detail ? "loaded" : "unavailable";
        if (detail) {
          installPhotoDetail(this.liver.material, detail, PHOTO_COLOUR_STRENGTH, 0);
          this.installFilmMaterial();
          for (const display of this.attachedRunoff.values()) this.installAttachedMaterial(display);
        }
        this.dirty = true;
      }).catch(() => { if (!this.disposed) { this.photoState = "unavailable"; this.dirty = true; } });
      else this.photoState = "unavailable";
    } catch (cause) {
      try { this.dispose(); }
      catch (cleanupCause) {
        throw new AggregateError([cause, cleanupCause], "Liver renderer initialization failed; cleanup also failed", { cause });
      }
      throw cause;
    }
  }

  private own<T extends Disposable>(resource: T): T { this.owned.add(resource); return resource; }
  private release(resource: Disposable) { if (this.owned.delete(resource)) resource.dispose(); }
  private prepareTissue(cut: LiverCutGeometry, geometry: BufferGeometry) {
    const count = cut.surface.positionsM.length / 3, rgb = new Float32Array(count * 3);
    const rest = new Array<number>(count * 3), regions = new Array<number>(count);
    const source = this.materialDefinition;
    const sampled = source ? sampleMaterialField(source.recipe, source.restPositions, source.regions).rgbLinear : null;
    const base = new Color(this.options.anatomy.organ.color);
    for (let i = 0; i < count; i++) {
      const { ids, weights } = sourceWeights(this.options.anatomy, cut, i);
      regions[i] = ids.reduce((sum, id, j) => sum + (source?.regions[id] ?? 0) * weights[j]!, 0);
      for (let axis = 0; axis < 3; axis++) {
        rest[i * 3 + axis] = ids.reduce((sum, id, j) =>
          sum + (source?.restPositions[id * 3 + axis] ?? this.options.anatomy.surface.positionsM[id * 3 + axis]! * MM) * weights[j]!, 0);
        rgb[i * 3 + axis] = sampled ? ids.reduce((sum, id, j) => sum + sampled[id * 3 + axis]! * weights[j]!, 0)
          : [base.r, base.g, base.b][axis]!;
      }
    }
    if (source) {
      // Reuse the immutable recipe with newly clipped rest-space attributes.
      installAtlasMaterial(geometry, this.liver.material, { ...source, restPositions: rest, regions });
      const material = this.liver.material, baseCompile = material.onBeforeCompile, baseKey = material.customProgramCacheKey;
      material.ior = CAPSULE_IOR; material.clearcoat = 0;
      material.onBeforeCompile = (shader, renderer) => {
        baseCompile.call(material, shader, renderer);
        // Preserve source pigment fields. Only the appearance of the capsule
        // interface is authored here; the source recipe and geometry stay
        // untouched. Photographic intensity is not converted to fake relief.
        shader.fragmentShader = shader.fragmentShader
          .replace("roughnessFactor = atlasSurface.roughness;", "roughnessFactor = max(0.28, atlasSurface.roughness);")
          .replaceAll("atlasSurface.heightGradientRest, faceDirection",
            `(atlasSurface.heightGradientRest * ${CAPSULE_RELIEF_SCALE}), faceDirection`);
      };
      material.customProgramCacheKey = () => `${baseKey.call(material)}:liver-capsule-interface-2`;
      // The photo wrapper keeps a saved shader; clear only our local material's
      // wrapper before reinstalling over a replacement geometry/material recipe.
      delete this.liver.material.userData.photoBase; delete this.liver.material.userData.photoKey;
      if (this.photo) installPhotoDetail(this.liver.material, this.photo, PHOTO_COLOUR_STRENGTH, 0);
    }
    this.filmMaterialDefinition = source ? { ...source, restPositions: rest, regions } : null;
    this.installFilmMaterial();
    return rgb;
  }
  private installFilmMaterial() {
    const material = this.film.material, definition = this.filmMaterialDefinition;
    delete material.userData.photoBase; delete material.userData.photoKey;
    if (definition) {
      installAtlasMaterial(this.film.geometry, material, definition);
      if (this.photo) installPhotoDetail(material, this.photo, PHOTO_COLOUR_STRENGTH, 0);
    } else {
      material.onBeforeCompile = () => {};
      material.customProgramCacheKey = () => "liver-film-constant-substrate";
    }
    this.capsuleReliefM = definition
      ? Number(definition.resolved.uniforms.uAtlasHeightAmplitudeMm) *
        Number(definition.resolved.uniforms.uAtlasFineDetail) * CAPSULE_RELIEF_SCALE / MM : 0;
    installLiverFilmOptics(material, this.filmTransportTexture, !!definition, this.capsuleReliefM, .36, true);
  }
  private makeGuide() {
    const points: number[] = [];
    for (const segment of this.options.anatomy.network.segments) {
      const midpoint = new Vector3(...segment.a_mm).add(new Vector3(...segment.b_mm)).multiplyScalar(.5 / MM);
      if (this.wounds.some(wound => midpoint.distanceTo(new Vector3(...wound.pick.positionM)) < wound.radiusM * 1.5)) continue;
      for (const endpoint of [segment.a_mm, segment.b_mm])
        points.push(endpoint[0] + segment.normal[0] * .025, endpoint[1] + segment.normal[1] * .025, endpoint[2] + segment.normal[2] * .025);
    }
    replaceAttribute(this.guides.geometry, "position", new Float32Array(points)); this.guides.geometry.computeBoundingSphere();
  }
  setWounds(wounds: readonly LiverWound[]) {
    if (this.disposed || this.lost) return;
    const next = wounds.map(copyWound), cut = buildLiverCutGeometry(this.options.anatomy, next);
    validateMapping(this.options.anatomy, cut);
    const surface = geometryFor(cut.surface), cavity = geometryFor(cut.cavity);
    const oldSurface = this.liver.geometry, oldCavity = this.cavity.geometry;
    try {
      const substrate = this.prepareTissue(cut, surface);
      const cache = createLiverFilmCache(this.options.anatomy, cut, substrate);
      this.cutGeometry = cut; this.substrateRGB = substrate; this.filmCache = cache; this.wounds = next;
      this.liver.geometry = this.own(surface); this.cavity.geometry = this.own(cavity);
      this.release(oldSurface); this.release(oldCavity);
      this.cancelGesture(); this.makeGuide(); this.film.visible = false; this.selected = null;
      this.marker.visible = false; this.cutPreview = null; this.vesselHighlight.visible = false;
      // The next pointer move re-announces the site so the preview reflects the new wound set.
      this.hoverKey = "none"; this.dirty = true;
    } catch (cause) { surface.dispose(); cavity.dispose(); throw cause; }
  }
  setMode(mode: "orbit" | "cut") {
    if (mode !== "orbit" && mode !== "cut") throw new RangeError("Unknown liver interaction mode");
    this.blur(); this.mode = mode; this.controls.enabled = !this.lost;
    // Cut mode: the primary button is reserved for the click-to-cut gesture handled
    // below; right-drag rotates and the wheel/middle button zooms. Touch stays blocked.
    this.controls.mouseButtons = mode === "cut" ? { LEFT: null, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.ROTATE }
      : { LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.PAN };
    this.canvas.style.cursor = mode === "cut" ? "crosshair" : "grab";
    this.showMarker(this.selected); this.dirty = true;
  }
  /** Colours the cut marker by predicted outcome and outlines the vessel it would open. Never changes physics. */
  setCutPreview(preview: LiverRendererCutPreview | null) {
    if (this.disposed || this.lost) return;
    this.cutPreview = preview ? { status: preview.status, segment: preview.segment } : null;
    this.marker.material.color.set(LIVER_CUT_PREVIEW_COLOURS[preview?.status ?? "idle"]);
    this.reticle.material.color.copy(this.marker.material.color);
    const segment = preview?.segment ?? null;
    if (segment) {
      const a = new Vector3(...segment.aM).multiplyScalar(MM), b = new Vector3(...segment.bM).multiplyScalar(MM);
      const axis = b.clone().sub(a), length = axis.length();
      this.vesselHighlight.position.copy(a).add(b).multiplyScalar(.5);
      if (length > 0) this.vesselHighlight.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), axis.multiplyScalar(1 / length));
      const radius = Math.max(segment.radiusAM, segment.radiusBM) * MM * 1.2;
      this.vesselHighlight.scale.set(radius, Math.max(length, radius), radius);
      this.vesselHighlight.material.color.set(LIVER_CUT_PREVIEW_COLOURS[preview!.status === "vessel" ? "vessel" : "deeper"]);
    }
    this.vesselHighlight.visible = this.mode === "cut" && !!segment && this.marker.visible;
    this.dirty = true;
  }
  setCutSettings(settings: { radiusM: number; depthM: number }) {
    if (!Number.isFinite(settings.radiusM) || settings.radiusM < .00075 || settings.radiusM > .002 ||
        !Number.isFinite(settings.depthM) || settings.depthM < .00025 || settings.depthM > .002)
      throw new RangeError("Cut radius or depth is outside the supported liver range");
    this.cancelGesture(); this.cutSettings = { ...settings }; this.showMarker(this.selected);
  }
  setAppearance(change: Partial<LiverAppearance>) {
    const next = { ...this.appearance, ...change };
    if (!["camera", "studio", "operating"].includes(next.illumination) || !Number.isFinite(next.exposureEV) ||
        next.exposureEV < -2 || next.exposureEV > 2 || typeof next.vesselGuide !== "boolean" ||
        !Number.isFinite(next.oxygenationFraction) || next.oxygenationFraction < 0 || next.oxygenationFraction > 1)
      throw new RangeError("Invalid liver appearance");
    if (this.disposed || this.lost) return;
    const oxygenationChanged = next.oxygenationFraction !== this.appearance.oxygenationFraction;
    this.appearance = next; this.applyLighting();
    if (oxygenationChanged) {
      liverFilmTransportTextureData(next.oxygenationFraction, this.filmTransportTexture.image.data as Float32Array);
      this.filmTransportTexture.needsUpdate = true;
    }
    if (this.frame) { this.updateFilm(this.frame.film); this.colourJets(); this.colourDrops(); }
    this.dirty = true;
  }
  private applyLighting() {
    const camera = this.appearance.illumination === "camera", studio = this.appearance.illumination === "studio";
    this.gpu.toneMappingExposure = 2 ** this.appearance.exposureEV;
    this.keyLight.visible = studio; this.cameraLight.visible = camera;
    this.operatingLight.visible = this.appearance.illumination === "operating";
    this.scene.environmentIntensity = studio ? .45 : camera ? .28 : .34;
    this.guides.visible = this.appearance.vesselGuide;
  }
  private aimOperatingLight(target: Vector3, normal: Vector3) {
    this.operatingTarget.copy(target); this.operatingNormal.copy(normal).normalize();
    this.operatingLight.position.copy(target).addScaledVector(this.operatingNormal, LIVER_OPERATING_PANEL.workingDistanceM * MM);
    // World-up gives repeatable panel roll. Only explicit site selection or
    // Fit liver re-aims this articulated apparatus; camera orbit leaves it fixed.
    this.operatingLight.up.set(0, 1, 0);
    if (Math.abs(this.operatingNormal.y) > .99) this.operatingLight.up.set(1, 0, 0);
    this.operatingLight.lookAt(target);
  }
  focusTarget(id: string) {
    const target = this.options.anatomy.targets.find(item => item.id === id);
    if (!target) throw new RangeError("Unknown liver target");
    if (this.disposed || this.lost) return;
    this.cancelGesture(); this.selectedTargetId = id; this.selected = copyPick(target.pick);
    const point = new Vector3(...target.pick.positionM).multiplyScalar(MM), normal = new Vector3(...target.pick.normal).normalize();
    this.aimOperatingLight(point, normal);
    const tangent = new Vector3(0, 1, 0);
    if (Math.abs(tangent.dot(normal)) > .95) tangent.set(1, 0, 0);
    tangent.addScaledVector(normal, -tangent.dot(normal)).normalize();
    const direction = normal.multiplyScalar(Math.cos(INSPECTION_OBLIQUITY))
      .addScaledVector(tangent, Math.sin(INSPECTION_OBLIQUITY));
    this.controls.target.copy(point); this.camera.zoom = 1;
    // Move the camera itself, preserving target-plane framing while giving
    // the actual close-view perspective. The declared lamp controller below
    // changes emitted intensity with distance; material/exposure do not change.
    this.camera.position.copy(point).addScaledVector(direction, liverInspectionWorkingDistanceM(this.radius / MM) * MM);
    this.controls.update(); this.camera.lookAt(point); this.clipping(); this.showMarker(this.selected); this.dirty = true;
    this.notifyHover(target.pick);
  }
  get selectedTarget(): LiverSurfacePick | null { return this.selected ? copyPick(this.selected) : null; }
  fitLiver() {
    if (this.disposed || this.lost) return;
    this.home();
  }
  private home() {
    this.cancelGesture(); this.camera.zoom = 1;
    const half = Math.min(Math.atan(Math.tan(this.camera.fov * Math.PI / 360) * this.camera.aspect), this.camera.fov * Math.PI / 360);
    const distance = this.radius / Math.sin(half) * 1.12;
    this.camera.position.copy(this.center).addScaledVector(this.homeDirection, distance);
    this.controls.target.copy(this.center); this.controls.update(); this.camera.lookAt(this.center); this.clipping(); this.dirty = true;
    this.aimOperatingLight(this.center, this.homeDirection);
  }
  private clipping() {
    const distance = this.camera.position.distanceTo(this.controls.target);
    this.camera.near = Math.max(.02, Math.min(distance * .015, this.radius * .05));
    this.camera.far = distance + this.radius * 20; this.camera.updateProjectionMatrix(); this.camera.updateMatrixWorld();
  }
  private syncCameraLamp() {
    const distanceM = this.camera.position.distanceTo(this.controls.target) / MM;
    this.cameraLight.position.copy(this.camera.position); this.cameraLight.target.position.copy(this.controls.target);
    this.cameraLight.intensity = relativeCameraLightPower(distanceM, CAMERA_IRRADIANCE);
  }
  private readonly onCameraChange = () => { this.clipping(); this.syncCameraLamp(); this.dirty = true; };
  private readonly resize = () => {
    if (this.disposed || this.lost || this.recording?.active) return;
    const width = Math.max(16, this.host.clientWidth), height = Math.max(16, this.host.clientHeight);
    this.gpu.setPixelRatio(Math.min(2, Math.max(1, devicePixelRatio || 1))); this.gpu.setSize(width, height);
    this.camera.aspect = width / height; this.clipping(); this.dirty = true;
  };
  /** Uses the actual native-capture canvas rectangle, including letterboxing. */
  pick(clientX: number, clientY: number): LiverSurfacePick | null {
    if (this.disposed || this.lost || ![clientX, clientY].every(Number.isFinite)) return null;
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height || clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null;
    this.pointer.set((clientX - rect.left) / rect.width * 2 - 1, 1 - (clientY - rect.top) / rect.height * 2);
    this.camera.updateMatrixWorld(); this.scene.updateMatrixWorld(true);
    this.ray.setFromCamera(this.pointer, this.camera);
    const hit = this.ray.intersectObjects([this.liver, this.cavity], false)[0];
    if (!hit || hit.object !== this.liver || hit.faceIndex == null || !hit.face) return null;
    const indices = this.cutGeometry.surface.indices;
    const vertexIndices = [indices[hit.faceIndex * 3]!, indices[hit.faceIndex * 3 + 1]!, indices[hit.faceIndex * 3 + 2]!];
    const positions = this.liver.geometry.getAttribute("position");
    const local = this.liver.worldToLocal(hit.point.clone());
    const weights = Triangle.getBarycoord(local, new Vector3().fromBufferAttribute(positions, vertexIndices[0]!),
      new Vector3().fromBufferAttribute(positions, vertexIndices[1]!), new Vector3().fromBufferAttribute(positions, vertexIndices[2]!), new Vector3());
    if (!weights) return null;
    const sourceTriangle = this.cutGeometry.sourceTriangles[vertexIndices[0]!]!;
    if (vertexIndices.some(index => this.cutGeometry.sourceTriangles[index] !== sourceTriangle))
      throw new Error("Retained cut triangle spans different canonical faces");
    const canonical = new Vector3();
    for (let corner = 0; corner < 3; corner++)
      canonical.addScaledVector(new Vector3().fromArray(this.cutGeometry.sourceBarycentrics, vertexIndices[corner]! * 3), weights.getComponent(corner));
    // Match the canonical smooth normal used by the wound planner. A flat
    // raster triangle normal can differ substantially on a curved capsule.
    const position = new Vector3(), normal = new Vector3(), source = this.options.anatomy.surface;
    for (let corner = 0; corner < 3; corner++) {
      const id = source.indices[sourceTriangle * 3 + corner]!, weight = canonical.getComponent(corner);
      position.addScaledVector(new Vector3().fromArray(source.positionsM, id * 3), weight);
      normal.addScaledVector(new Vector3().fromArray(source.normals, id * 3), weight);
    }
    normal.applyMatrix3(new Matrix3().getNormalMatrix(this.liver.matrixWorld)).normalize();
    return { triangle: sourceTriangle, barycentric: tuple(canonical), positionM: tuple(position), normal: tuple(normal) };
  }
  private showMarker(pick: LiverSurfacePick | null) {
    this.marker.visible = this.mode === "cut" && !!pick && !this.lost;
    this.vesselHighlight.visible = this.marker.visible && !!this.cutPreview?.segment;
    if (pick) {
      const normal = new Vector3(...pick.normal).normalize();
      this.marker.position.copy(new Vector3(...pick.positionM).multiplyScalar(MM)).addScaledVector(normal, .035);
      this.marker.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), normal);
      this.marker.scale.setScalar(this.cutSettings.radiusM * MM);
    }
    this.dirty = true;
  }
  /** Reticle: ~18 px radius on screen, shown only while the true cut ring is smaller than ~12 px. */
  private sizeReticle() {
    if (!this.marker.visible) { this.reticle.visible = false; return; }
    const height = Math.max(1, this.canvas.clientHeight), distance = this.camera.position.distanceTo(this.marker.position);
    const worldPerPixel = 2 * distance * Math.tan(this.camera.fov * Math.PI / 360) / (height * this.camera.zoom);
    const ringPixels = this.marker.scale.x / worldPerPixel;
    this.reticle.visible = ringPixels < 12;
    this.reticle.position.copy(this.marker.position); this.reticle.quaternion.copy(this.marker.quaternion);
    this.reticle.scale.setScalar(18 * worldPerPixel);
  }
  private readonly pointerEvent = (event: PointerEvent) => {
    if (this.disposed || this.lost) return;
    if (event.type === "pointerdown") {
      this.downPointers.add(event.pointerId);
      if (this.downPointers.size > 1) this.multiTouchBlocked = true;
    }
    if (this.mode !== "cut") {
      if (["pointerup", "pointercancel", "lostpointercapture"].includes(event.type)) {
        this.downPointers.delete(event.pointerId); if (!this.downPointers.size) this.multiTouchBlocked = false;
      }
      return;
    }
    // Non-primary mouse buttons belong to OrbitControls (rotate / zoom). They are
    // routed before the cut gesture and can never select or cut a site.
    if (event.pointerType === "mouse" && (this.orbitPointers.has(event.pointerId) || (event.type === "pointerdown" && event.button !== 0))) {
      if (event.type === "pointerdown") { this.cancelGesture(); this.orbitPointers.add(event.pointerId); }
      else if (event.type !== "pointermove") {
        this.orbitPointers.delete(event.pointerId); this.downPointers.delete(event.pointerId);
        if (!this.downPointers.size) this.multiTouchBlocked = false;
      }
      return;
    }
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.type === "pointerdown") {
      if (!event.isPrimary || event.button !== 0 || this.downPointers.size !== 1 || this.multiTouchBlocked) { this.cancelGesture(); return; }
      const pick = this.pick(event.clientX, event.clientY);
      this.canvas.focus({ preventScroll: true }); this.canvas.setPointerCapture(event.pointerId);
      this.gesture = { id: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false, pick };
      this.selected = pick; this.selectedTargetId = null; this.showMarker(pick); this.notifyHover(pick);
    } else if (event.type === "pointermove") {
      if (this.gesture?.id === event.pointerId) {
        this.gesture.moved ||= Math.hypot(event.clientX - this.gesture.startX, event.clientY - this.gesture.startY) > 5;
      } else if (!this.gesture && !event.buttons) {
        const pick = this.pick(event.clientX, event.clientY); this.selected = pick;
        this.showMarker(pick); this.notifyHover(pick);
      }
    } else if (event.type === "pointerup") {
      const gesture = this.gesture, eligible = gesture?.id === event.pointerId && !gesture.moved &&
        Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) <= 5 &&
        this.downPointers.size === 1 && !this.multiTouchBlocked;
      const pick = eligible ? this.pick(event.clientX, event.clientY) : null;
      this.cancelGesture(); this.downPointers.delete(event.pointerId);
      if (!this.downPointers.size) this.multiTouchBlocked = false;
      if (pick && gesture?.pick) {
        this.selected = copyPick(pick); this.showMarker(pick);
        try { this.options.onSurfacePick(copyPick(pick)); }
        catch (cause) { this.options.onError?.(cause instanceof Error ? cause.message : String(cause)); }
      }
    } else {
      this.downPointers.delete(event.pointerId); this.cancelGesture();
      if (!this.downPointers.size) this.multiTouchBlocked = false;
    }
  };
  private readonly cancelGesture = () => {
    const id = this.gesture?.id; this.gesture = null;
    if (id !== undefined && this.canvas.hasPointerCapture(id)) this.canvas.releasePointerCapture(id);
    this.dirty = true;
  };
  private readonly blur = () => { this.cancelGesture(); this.downPointers.clear(); this.orbitPointers.clear(); this.multiTouchBlocked = false; };
  private notifyHover(pick: LiverSurfacePick | null) {
    const key = pick ? `${pick.triangle}:${pick.positionM.join(",")}` : "none";
    if (key === this.hoverKey) return;
    this.hoverKey = key; this.options.onHover?.(pick ? copyPick(pick) : null);
  }
  private readonly pointerLeave = () => {
    if (!this.gesture) { this.showMarker(null); this.notifyHover(null); }
  };
  private readonly wheel = (event: WheelEvent) => {
    // Zoom stays available in cut mode, but never while a click-to-cut press is held.
    if (this.mode === "cut" && this.gesture) { event.preventDefault(); event.stopImmediatePropagation(); }
  };
  private readonly key = (event: KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); this.cancelGesture(); this.showMarker(null); return; }
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "=", "-", "Home"].includes(event.key)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (this.gesture || this.lost) return;
    if (event.key === "Home") { this.home(); return; }
    // Keyboard camera navigation is available even when cut mode is selected,
    // but never while a pointer is held. It cannot activate an incision.
    if (event.key === "ArrowLeft") this.controls.rotateLeft(.1);
    if (event.key === "ArrowRight") this.controls.rotateLeft(-.1);
    if (event.key === "ArrowUp") this.controls.rotateUp(.1);
    if (event.key === "ArrowDown") this.controls.rotateUp(-.1);
    // OrbitControls uses a multiplicative factor below 1 for dollyIn;
    // dollyOut divides by that same factor. Values above 1 reverse the keys.
    if (event.key === "+" || event.key === "=") this.controls.dollyIn(1 / 1.1);
    if (event.key === "-") this.controls.dollyOut(1 / 1.1);
    this.controls.update(); this.dirty = true;
  };
  private colourJets() {
    const colours = new Float32Array(this.jetThickness.length * 3);
    for (let i = 0; i < this.jetThickness.length; i++)
      colours.set(bloodAppearanceTransport(this.jetThickness[i]!, this.appearance.oxygenationFraction).reflectance, i * 3);
    replaceAttribute(this.jets.geometry, "color", colours);
  }
  private colourDrops() {
    if (!this.drops) return;
    const colour = new Color();
    for (let i = 0; i < this.acceptedDrops.length; i++)
      this.drops.setColorAt(i, colour.setRGB(...bloodAppearanceTransport(this.acceptedDrops[i]!.radiusM * 2,
        this.appearance.oxygenationFraction).reflectance));
    if (this.drops.instanceColor) this.drops.instanceColor.needsUpdate = true;
  }
  private prepareAttached(shapes: readonly RunoffAttached[]) {
    if (shapes.length > 1024) throw new RangeError("Too many accepted runoff supports");
    const ids = new Set<string>();
    const prepared = shapes.map(shape => {
      if (!shape.id || ids.has(shape.id) || !finitePoint(shape.anchorM) || !finitePoint(shape.normal) ||
          !finitePoint(shape.centreOfMassM) || Math.abs(Math.hypot(...shape.normal) - 1) > 1e-8)
        throw new RangeError("Invalid attached runoff pose or duplicate support");
      ids.add(shape.id);
      const mapping = shape.anchorSurface;
      if (mapping && (!Number.isSafeInteger(mapping.triangle) || mapping.triangle < 0 ||
          mapping.triangle >= this.options.anatomy.surface.indices.length / 3 ||
          !finitePoint(mapping.barycentric) || mapping.barycentric.some(v => v < -1e-8 || v > 1 + 1e-8) ||
          Math.abs(mapping.barycentric.reduce((a, b) => a + b, 0) - 1) > 1e-8))
        throw new RangeError("Invalid attached runoff source mapping");
      const signature = JSON.stringify(shape), old = this.attachedRunoff.get(shape.id);
      const data = old?.signature === signature ? old.data : attachedRunoffGeometry(shape);
      // This is a finite curved-surface tessellation, never a radius correction.
      if (data.resolved && data.relativeVolumeError > .004)
        throw new RangeError("Attached runoff tessellation exceeds its validated volume error");
      return { shape, signature, data };
    });
    let accepted = 0, resolved = 0, measured = 0, unresolved = 0, unresolvedBound = 0;
    for (const { shape, data } of prepared) {
      accepted += shape.volumeM3; measured += data.reconstructedVolumeM3;
      if (data.resolved) resolved += shape.volumeM3;
      else { unresolved += data.unresolvedVolumeM3; unresolvedBound += data.unresolvedVolumeBoundM3; }
    }
    if (unresolved > unresolvedBound * (1 + 1e-12) ||
        Math.abs(measured - accepted) > .004 * resolved + unresolvedBound + accepted * Number.EPSILON * shapes.length)
      throw new RangeError("Aggregate attached display inventory exceeds tessellation and Float32 bounds");
    return prepared;
  }
  private attachedDefinition(shape: RunoffAttached, data: ReturnType<typeof attachedRunoffGeometry>) {
    const source = this.materialDefinition, mapping = shape.anchorSurface;
    if (!source || !mapping) return null;
    const { surface } = this.options.anatomy, offset = mapping.triangle * 3;
    const ids = [surface.indices[offset]!, surface.indices[offset + 1]!, surface.indices[offset + 2]!];
    const points = ids.map(id => new Vector3().fromArray(surface.positionsM, id * 3));
    const basis = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), new Vector3(...shape.normal));
    const position = new Vector3(), weights = new Vector3(), anchor = new Vector3(...shape.anchorM);
    const count = data.positions.length / 3, rest = new Array<number>(count * 3), regions = new Array<number>(count);
    for (let i = 0; i < count; i++) {
      // Substrate coordinates use the source facet's affine tangent extension
      // under this small authored support. Axial fluid displacement never
      // stretches tissue texture. Thick blood screens the underlying substrate.
      position.set(data.positions[i * 3]! / MM, 0, data.positions[i * 3 + 2]! / MM).applyQuaternion(basis).add(anchor);
      if (!Triangle.getBarycoord(position, points[0]!, points[1]!, points[2]!, weights))
        throw new RangeError("Degenerate runoff support source triangle");
      const w = weights.toArray();
      regions[i] = ids.reduce((sum, id, j) => sum + source.regions[id]! * w[j]!, 0);
      for (let axis = 0; axis < 3; axis++)
        rest[i * 3 + axis] = ids.reduce((sum, id, j) => sum + source.restPositions[id * 3 + axis]! * w[j]!, 0);
    }
    return { ...source, restPositions: rest, regions };
  }
  private installAttachedMaterial(display: AttachedDisplay) {
    const { mesh, definition } = display, material = mesh.material;
    delete material.userData.photoBase; delete material.userData.photoKey;
    if (definition) {
      installAtlasMaterial(mesh.geometry, material, definition);
      if (this.photo) installPhotoDetail(material, this.photo, PHOTO_COLOUR_STRENGTH, 0);
    } else {
      material.onBeforeCompile = () => {};
      material.customProgramCacheKey = () => "liver-attached-constant-substrate";
    }
    installLiverFilmOptics(material, this.filmTransportTexture, !!definition, this.capsuleReliefM, .36);
  }
  private updateAttached(prepared: ReturnType<LiverRenderer["prepareAttached"]>) {
    const present = new Set(prepared.map(item => item.shape.id));
    for (const [id, display] of this.attachedRunoff) if (!present.has(id)) {
      this.scene.remove(display.mesh); this.release(display.mesh.geometry); this.release(display.mesh.material);
      this.attachedRunoff.delete(id);
    }
    this.attachedAcceptedVolume = this.attachedMeshVolume = this.attachedMaximumRelativeError = 0;
    this.attachedUnresolvedVolume = this.attachedUnresolvedBound = this.attachedUnresolvedCount = 0;
    for (const { shape, signature, data } of prepared) {
      let display = this.attachedRunoff.get(shape.id);
      const changed = display?.signature !== signature, newDisplay = !display;
      const previouslyResolved = display?.data.resolved ?? false;
      if (!display) {
        const mesh = new Mesh(this.own(new BufferGeometry()), this.own(new MeshPhysicalMaterial({
          color: 0xffffff, roughness: .045, ior: 1.35, side: FrontSide,
          polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
        })));
        mesh.castShadow = mesh.receiveShadow = true;
        display = { mesh, signature, data, definition: null };
        this.attachedRunoff.set(shape.id, display); this.scene.add(mesh);
      }
      if (changed && data.resolved) {
        const geometry = display.mesh.geometry, count = data.positions.length / 3;
        replaceAttribute(geometry, "position", data.positions); replaceAttribute(geometry, "normal", data.normals);
        geometry.setIndex(new BufferAttribute(data.indices, 1));
        replaceAttribute(geometry, "liverThicknessM", new Float32Array(count).fill(data.axialOpticalThicknessM), 1);
        const substrate = new Float32Array(count * 3), capsuleNormal = new Float32Array(count * 3);
        const colour = new Color(this.options.anatomy.organ.color);
        for (let i = 0; i < count; i++) {
          substrate.set([colour.r, colour.g, colour.b], i * 3); capsuleNormal[i * 3 + 1] = 1;
        }
        replaceAttribute(geometry, "liverSubstrateLinear", substrate);
        replaceAttribute(geometry, "liverCapsuleNormal", capsuleNormal);
        const hadAtlas = !!display.definition;
        display.definition = this.attachedDefinition(shape, data);
        if (newDisplay || !previouslyResolved || hadAtlas !== !!display.definition) this.installAttachedMaterial(display);
        else if (display.definition) {
          replaceAttribute(geometry, "atlasRestPosition", Float32Array.from(display.definition.restPositions));
          replaceAttribute(geometry, "atlasMaterialRegion", Float32Array.from(display.definition.regions), 1);
        }
        geometry.computeBoundingSphere();
      }
      display.mesh.visible = data.resolved;
      display.mesh.position.set(...shape.anchorM.map(value => value * MM) as LiverVec3);
      display.mesh.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), new Vector3(...shape.normal));
      display.signature = signature; display.data = data;
      this.attachedAcceptedVolume += shape.volumeM3; this.attachedMeshVolume += data.reconstructedVolumeM3;
      if (data.resolved)
        this.attachedMaximumRelativeError = Math.max(this.attachedMaximumRelativeError, data.relativeVolumeError);
      else {
        this.attachedUnresolvedCount++;
        this.attachedUnresolvedVolume += data.unresolvedVolumeM3;
        this.attachedUnresolvedBound += data.unresolvedVolumeBoundM3;
      }
    }
  }
  private updateCollector(state: LiverFlowSnapshot["collector"], prepared: ReturnType<typeof prepareDryCollectorDisplay>) {
    const { data, positionMm } = prepared, domain = state.domain;
    if (data) {
      const count = data.positions.length / 3, geometry = this.collectorFilm.geometry;
      replaceAttribute(geometry, "position", data.positions); replaceAttribute(geometry, "normal", data.normals);
      geometry.setIndex(new BufferAttribute(data.indices, 1));
      const thickness = new Float32Array(count), substrate = new Float32Array(count * 3), normals = new Float32Array(count * 3);
      const colour = (this.collectionFloor.material as MeshStandardMaterial).color;
      for (let i = 0; i < count; i++) {
        thickness[i] = data.positions[i * 3 + 1]! / MM; normals[i * 3 + 1] = 1;
        substrate.set([colour.r, colour.g, colour.b], i * 3);
      }
      replaceAttribute(geometry, "liverThicknessM", thickness, 1);
      replaceAttribute(geometry, "liverSubstrateLinear", substrate); replaceAttribute(geometry, "liverCapsuleNormal", normals);
      geometry.computeBoundingSphere();
    }
    this.collectorFilm.position.copy(positionMm);
    this.collectorFilm.visible = state.filmVolumeM3 > 0;
    if (!this.collectorDomain || JSON.stringify(this.collectorDomain) !== JSON.stringify(domain)) {
      const width = domain.widthM * MM, depth = domain.depthM * MM;
      const wallHeight = Math.min(width, depth) * DRY_COLLECTOR_MODEL.maximumHeightFraction, thicknessMm = 1;
      this.collectionFloor.scale.set(width, depth, 1); this.collectionFloor.position.copy(positionMm); this.collectionFloor.visible = true;
      for (let i = 0; i < 4; i++) {
        const wall = this.collectorWalls[i]!, alongX = i < 2, sign = i % 2 === 0 ? -1 : 1;
        wall.scale.set(alongX ? thicknessMm : width, wallHeight, alongX ? depth + thicknessMm * 2 : thicknessMm);
        wall.position.copy(positionMm).add(new Vector3(alongX ? sign * (width + thicknessMm) / 2 : 0,
          wallHeight / 2, alongX ? 0 : sign * (depth + thicknessMm) / 2));
        wall.visible = true;
      }
      this.collectorDomain = { ...domain };
    }
    this.collectorAcceptedVolume = state.filmVolumeM3; this.collectorVolume = prepared.reconstructedVolumeM3;
  }
  private updateFilm(film: LiverFilmSnapshot, prepared?: ReturnType<typeof updateLiverFilmCache>) {
    const data = prepared ?? updateLiverFilmCache(this.filmCache, film, this.appearance.oxygenationFraction);
    const tolerance = Math.max(1e-16, Math.abs(film.filmVolumeM3) * 1e-7);
    if (Math.abs(data.volumeM3 - film.filmVolumeM3) > tolerance)
      throw new RangeError("Rendered retained-surface film inventory differs from the accepted physical film");
    const newTopology = this.film.geometry.getAttribute("position")?.array !== data.smoothPositions;
    if (newTopology) {
      this.film.geometry.setAttribute("position", new BufferAttribute(data.smoothPositions, 3).setUsage(DynamicDrawUsage));
      this.film.geometry.setAttribute("color", new BufferAttribute(data.colours, 4).setUsage(DynamicDrawUsage));
      this.film.geometry.setAttribute("normal", new BufferAttribute(data.smoothNormals, 3).setUsage(DynamicDrawUsage));
      this.film.geometry.setAttribute("liverThicknessM", new BufferAttribute(data.thicknessM, 1).setUsage(DynamicDrawUsage));
      this.film.geometry.setAttribute("liverSmoothThicknessM", new BufferAttribute(data.smoothThicknessM, 1).setUsage(DynamicDrawUsage));
      this.film.geometry.setAttribute("liverSubstrateLinear", new BufferAttribute(this.substrateRGB, 3));
      this.film.geometry.setAttribute("liverCapsuleNormal", new BufferAttribute(data.capsuleNormals, 3));
      this.film.geometry.setAttribute("liverSmoothNormal", new BufferAttribute(data.smoothNormals, 3).setUsage(DynamicDrawUsage));
      this.film.geometry.setAttribute("liverSmoothGradient", new BufferAttribute(data.smoothGradient, 3).setUsage(DynamicDrawUsage));
    } else {
      if (data.positionChanged) {
        this.film.geometry.getAttribute("position").needsUpdate = true;
        this.film.geometry.getAttribute("normal").needsUpdate = true;
        this.film.geometry.getAttribute("liverThicknessM").needsUpdate = true;
        this.film.geometry.getAttribute("liverSmoothThicknessM").needsUpdate = true;
        this.film.geometry.getAttribute("liverSmoothNormal").needsUpdate = true;
        this.film.geometry.getAttribute("liverSmoothGradient").needsUpdate = true;
      }
      if (data.colourChanged) this.film.geometry.getAttribute("color").needsUpdate = true;
    }
    if (!this.film.geometry.index || this.film.geometry.index.count !== this.cutGeometry.surface.indices.length)
      this.film.geometry.setIndex(new BufferAttribute(this.cutGeometry.surface.indices.slice(), 1));
    else { this.film.geometry.index.array.set(this.cutGeometry.surface.indices); this.film.geometry.index.needsUpdate = true; }
    if (newTopology || data.maximumDepthM !== this.filmMaximum) {
      this.film.geometry.boundingSphere = this.liver.geometry.boundingSphere!.clone();
      this.film.geometry.boundingSphere.radius += (data.maximumDepthM + LIVER_FILM_VISUAL_RELIEF.maximumM) * MM;
    }
    this.film.visible = data.wetVertices > 0; this.filmVolume = data.volumeM3;
    liverFilmUniforms(this.film.material).reliefScale.value = liverFilmReliefScaleM(data.maximumDepthM);
    this.filmMaximum = data.maximumDepthM; this.wetVertices = data.wetVertices;
  }
  update(frame: LiverFlowSnapshot) {
    if (this.disposed || this.lost) return;
    if (!Number.isFinite(frame.timeSeconds) || frame.timeSeconds < this.time || frame.film.timeSeconds !== frame.timeSeconds ||
        frame.breakup.timeSeconds !== frame.timeSeconds || frame.runoff.timeSeconds !== frame.timeSeconds ||
        frame.collector.timeSeconds !== frame.timeSeconds || frame.wounds.length !== this.wounds.length ||
        frame.wounds.some((wound, index) => wound.id !== this.wounds[index]!.id))
      throw new RangeError("Liver renderer needs synchronized accepted time and committed wound geometry");
    validateDroplets(frame.breakup.droplets);
    const runoffDrops: DropletGeometryInput[] = frame.runoff.droplets.map(drop => ({
      id: drop.id, holeId: "attached-runoff", positionM: drop.positionM, radiusM: drop.radiusM, volumeM3: drop.volumeM3,
    }));
    validateDroplets(runoffDrops);
    const jets = ligamentGeometryData(frame.breakup.ligaments);
    const attached = this.prepareAttached(frame.runoff.attached), collector = prepareDryCollectorDisplay(frame.collector);
    const attachedVolume = frame.runoff.attached.reduce((sum, shape) => sum + shape.volumeM3, 0);
    const runoffDropVolume = runoffDrops.reduce((sum, drop) => sum + drop.volumeM3, 0);
    for (const [actual, accepted] of [[attachedVolume, frame.runoff.attachedVolumeM3], [runoffDropVolume, frame.runoff.inFlightVolumeM3]])
      if (!Number.isFinite(accepted) || accepted! < 0 || Math.abs(actual! - accepted!) > Math.max(1e-20, accepted! * 1e-10))
        throw new RangeError("Runoff shapes and accepted inventory disagree");
    if (Math.abs(frame.collector.domain.collectionPlaneYM - liverCollectionPlaneYM(this.options.anatomy.surface)) > 1e-12)
      throw new RangeError("Collector domain and accepted anatomical collection plane disagree");
    // Validate and construct all numerical geometry before GPU-buffer mutation.
    // Exact P1 volume is a precomputed linear area functional. Check it before
    // touching the shared persistent display buffers.
    if (frame.film.depthM.length !== this.filmCache.areaCoefficients.length)
      throw new RangeError("Accepted film has the wrong canonical vertex count");
    let expectedFilmVolume = 0;
    for (let i = 0; i < frame.film.depthM.length; i++) {
      const h = frame.film.depthM[i]!;
      if (!Number.isFinite(h) || h < 0) throw new RangeError("Invalid accepted liver film");
      expectedFilmVolume += h * this.filmCache.areaCoefficients[i]!;
    }
    if (!Number.isFinite(frame.film.filmVolumeM3) || Math.abs(expectedFilmVolume - frame.film.filmVolumeM3) > Math.max(1e-16, frame.film.filmVolumeM3 * 1e-7))
      throw new RangeError("Accepted film cannot be represented on the retained capsule");
    const filmData = updateLiverFilmCache(this.filmCache, frame.film, this.appearance.oxygenationFraction);
    this.updateFilm(frame.film, filmData);
    this.updateAttached(attached); this.updateCollector(frame.collector, collector);
    this.jetThickness = jets.thicknessM;
    replaceAttribute(this.jets.geometry, "position", jets.positions);
    replaceAttribute(this.jets.geometry, "normal", jets.normals);
    this.jets.geometry.setIndex(new BufferAttribute(jets.indices, 1)); this.jets.geometry.computeBoundingSphere();
    this.colourJets(); this.jets.visible = jets.indices.length > 0;
    const drops = [...frame.breakup.droplets, ...runoffDrops];
    if (drops.length > this.dropCapacity) {
      this.dropCapacity = Math.min(16384, 2 ** Math.ceil(Math.log2(Math.max(16, drops.length))));
      if (this.drops) { this.scene.remove(this.drops); this.release(this.drops); }
      this.drops = this.own(new InstancedMesh(this.dropGeometry, this.dropMaterial, this.dropCapacity));
      this.drops.instanceMatrix.setUsage(DynamicDrawUsage); this.drops.castShadow = true; this.scene.add(this.drops);
    }
    this.acceptedDrops = drops.map(drop => ({ ...drop, positionM: [...drop.positionM] }));
    if (this.drops) {
      const matrix = new Matrix4();
      for (let i = 0; i < drops.length; i++) {
        const drop = drops[i]!, r = drop.radiusM * MM * this.dropRadiusCorrection;
        matrix.makeScale(r, r, r).setPosition(...drop.positionM.map(value => value * MM) as LiverVec3);
        this.drops.setMatrixAt(i, matrix);
      }
      this.drops.count = drops.length; this.drops.visible = drops.length > 0;
      this.drops.instanceMatrix.needsUpdate = true; this.drops.computeBoundingSphere(); this.colourDrops();
    }
    // Only small numeric buffers needed for appearance changes are retained.
    this.frame = { ...frame, film: { ...frame.film, depthM: frame.film.depthM.slice(), vertexAreaM2: frame.film.vertexAreaM2.slice() } };
    {
      const filmUniforms = liverFilmUniforms(this.film.material);
      const activity = liverFilmFlowActivity(frame.vessel.jets.reduce((sum, jet) => sum + jet.flowM3S, 0));
      const dt = Math.max(0, frame.timeSeconds - this.time);
      filmUniforms.clock.value = (filmUniforms.clock.value + dt * (.25 + .75 * activity)) % 1e4;
      filmUniforms.activity.value = activity;
    }
    this.time = frame.timeSeconds; this.jetVolume = jets.volumeM3; this.ligamentCount = frame.breakup.ligaments.length;
    this.dropVolume = drops.reduce((sum, drop) => sum + drop.volumeM3, 0);
    this.sourceDropCount = frame.breakup.droplets.length; this.runoffDropCount = runoffDrops.length;
    this.runoffDropVolume = runoffDropVolume; this.dirty = true;
  }
  private projectedTargets() {
    this.camera.updateMatrixWorld();
    const rect = this.canvas.getBoundingClientRect();
    return this.options.anatomy.targets.map(target => {
      const p = new Vector3(...target.pick.positionM).multiplyScalar(MM).project(this.camera);
      const clientX = rect.left + (p.x + 1) * rect.width / 2, clientY = rect.top + (1 - p.y) * rect.height / 2;
      const visiblePick = Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 && Math.abs(p.z) <= 1 ? this.pick(clientX, clientY) : null;
      return { id: target.id, label: target.label, vesselId: target.vesselId, clientX, clientY,
        visible: !!visiblePick && new Vector3(...visiblePick.positionM).distanceTo(new Vector3(...target.pick.positionM)) < .0001,
        positionM: [...target.pick.positionM] };
    });
  }
  get visualState() {
    return { timeSeconds: this.time, contextLost: this.lost, recording: this.recording?.active ?? false,
      mode: this.mode, appearance: { ...this.appearance }, cutSettings: { ...this.cutSettings },
      cameraPosition: this.camera.position.toArray(), cameraTarget: this.controls.target.toArray(),
      cameraQuaternion: this.camera.quaternion.toArray(), cameraProjection: this.camera.projectionMatrix.toArray(),
      cameraWorldMatrix: this.camera.matrixWorld.toArray(), cameraCoordinates: "millimetres",
      cameraRig: {
        workingDistanceM: this.camera.position.distanceTo(this.controls.target) / MM,
        zoom: this.camera.zoom, verticalFieldOfViewDegrees: this.camera.getEffectiveFOV(),
        lampControl: "Automatic emitted intensity I=E_ref*d_mm²; on-axis perpendicular-plane irradiance held fixed",
        referenceRelativeIrradiance: CAMERA_IRRADIANCE, relativeLampIntensity: this.cameraLight.intensity,
        irradianceConvention: "Relative radiometric rendering units, not measured lux/lumens; tissue cosine and inverse-square spatial falloff remain",
        inspectionWorkingDistanceM: liverInspectionWorkingDistanceM(this.radius / MM),
      },
      operatingLight: {
        enabled: this.operatingLight.visible, ...LIVER_OPERATING_PANEL,
        positionM: this.operatingLight.position.toArray().map(value => value / MM),
        targetM: this.operatingTarget.toArray().map(value => value / MM), siteNormal: this.operatingNormal.toArray(),
        relativeRadiance: this.operatingLight.intensity,
        projectedSolidAngle: rectangularEmitterProjectedSolidAngle(LIVER_OPERATING_PANEL.widthM,
          LIVER_OPERATING_PANEL.heightM, LIVER_OPERATING_PANEL.workingDistanceM),
        aiming: "Selected-site normal; fixed world pose during camera navigation; Fit liver re-aims at organ centre",
        shadowSupport: false, interreflection: false,
        limitation: "Finite uniform authored panel with LTC shading. Three RectAreaLight has no shadow support; tissue occlusion and secondary reflections are not resolved. Not calibrated surgical lighting.",
      },
      projectedTargets: this.projectedTargets(), selectedTargetId: this.selectedTargetId,
      selectedTarget: this.selectedTarget, woundCount: this.wounds.length, removedAreaM2: this.cutGeometry.removedAreaM2,
      retainedSurfaceTriangles: this.cutGeometry.surface.indices.length / 3, cavityTriangles: this.cutGeometry.cavity.indices.length / 3,
      filmVolumeM3: this.filmVolume, filmVolumeConvention: "retained-surface area integral of canonical P1 thickness",
      maxFilmDepthM: this.filmMaximum, wetVertices: this.wetVertices, photoDetail: this.photoState,
      presentation: { capsuleIOR: CAPSULE_IOR, capsuleReliefScale: CAPSULE_RELIEF_SCALE,
        photoColourStrength: PHOTO_COLOUR_STRENGTH, photoReliefMm: 0, cameraIrradiance: CAMERA_IRRADIANCE,
        filmNormals: "area-weighted actual displaced facets; canonical-topology smoothing",
        filmVisualRelief: { ...LIVER_FILM_VISUAL_RELIEF, law: "h_vis = max·tanh(h/s), s = max(min, fraction·peak); exact height-field normals; outflow-driven ripples and colour streaks; maroon core vs scarlet rim; refracted optical path; presentation only" },
        filmOptics: "complete linear R+T²S/(1−RS) diffuse stack before PBR/tone mapping; independent dielectric boundary; no framebuffer alpha mixing",
        filmLeveling: { capsuleReliefM: this.capsuleReliefM, law: "h/(h+authored capsule relief)",
          effect: "Optical normal and fourth-power roughness blend only; physical depth, support and inventory unchanged",
          interpretation: "Uncalibrated subgrid rendering closure; not measured hepatic wetting" },
        wettingLimit: "Any resolved positive P1 thickness is a covered continuum interface; its BRDF approaches the capsule for h→0. Molecular wetting/contact-line microstructure is unresolved",
        inspectionObliquityDegrees: INSPECTION_OBLIQUITY * 180 / Math.PI,
        calibration: "Authored appearance; not calibrated surgical camera or measured capsule BRDF" },
      ligamentCount: this.ligamentCount, dropletCount: this.acceptedDrops.length,
      reconstructedJetVolumeM3: this.jetVolume, reconstructedDropletVolumeM3: this.dropVolume,
      sourceDropletCount: this.sourceDropCount, runoffDropletCount: this.runoffDropCount,
      runoff: {
        attachedCount: this.attachedRunoff.size, attachedAcceptedVolumeM3: this.attachedAcceptedVolume,
        attachedReconstructedVolumeM3: this.attachedMeshVolume,
        maximumTessellationRelativeError: this.attachedMaximumRelativeError,
        unresolvedDisplayVolumeM3: this.attachedUnresolvedVolume,
        unresolvedDisplayVolumeBoundM3: this.attachedUnresolvedBound,
        unresolvedDisplayCount: this.attachedUnresolvedCount,
        displayResolution: "Only a physical axial thickness rounding to zero in the Float32 metre optical attribute is unresolved; exact accepted volume is retained, with no geometry or coverage invented",
        inFlightVolumeM3: this.runoffDropVolume,
        geometryConvention: "Accepted cylinder and spherical-cap dimensions; measured finite-mesh volume error, no radius or height rescaling",
        optics: "Axial support-height diffuse slab with source-facet tangent atlas/photo substrate; continuous capsule-to-fluid BRDF; not volumetric ray transport",
        supports: [...this.attachedRunoff].map(([id, item]) => ({
          id, anchorM: item.mesh.position.toArray().map(value => value / MM),
          normal: new Vector3(0, 1, 0).applyQuaternion(item.mesh.quaternion).toArray(),
          acceptedVolumeM3: item.data.analyticVolumeM3, reconstructedVolumeM3: item.data.reconstructedVolumeM3,
          axialOpticalThicknessM: item.data.axialOpticalThicknessM,
          physicalAxialThicknessM: item.data.physicalAxialThicknessM, displayResolved: item.data.resolved,
          unresolvedDisplayVolumeM3: item.data.unresolvedVolumeM3,
        })),
      },
      collector: { domain: this.collectorDomain ? { ...this.collectorDomain } : null,
        acceptedVolumeM3: this.collectorAcceptedVolume, reconstructedVolumeM3: this.collectorVolume,
        initialFilmVolumeM3: 0, visible: this.collectorFilm.visible,
        geometryConvention: "Nonnegative shared-corner reconstruction and conservative four-triangle centre fan; true zero dry state",
        closedWallHeightM: this.collectorDomain ?
          Math.min(this.collectorDomain.widthM, this.collectorDomain.depthM) * DRY_COLLECTOR_MODEL.maximumHeightFraction : 0 },
      collectionPlaneYM: this.collectionFloor.position.y / MM,
      vesselGuide: "Procedural surface guide; not observed patient vasculature",
    };
  }
  get needsRender() { return !this.disposed && !this.lost && (this.dirty || !!this.recording?.active); }
  render() {
    if (this.disposed || this.lost) return;
    this.syncCameraLamp(); this.sizeReticle();
    this.gpu.render(this.scene, this.camera); this.dirty = false;
  }
  private readonly contextLost = (event: Event) => {
    event.preventDefault(); if (this.lost || this.disposed) return;
    this.lost = true; this.cancelGesture(); this.controls.enabled = false; this.detachAbort?.();
    this.options.onError?.("Liver graphics context lost. Reset the experiment to recover.");
  };
  dispose() {
    if (this.disposed) return; this.disposed = true;
    // Construction can fail before canvas/controls exist, or between any two
    // owned allocations. Complete all cleanup even if one disposer fails.
    const failures: unknown[] = [];
    const attempt = (action: () => void) => { try { action(); } catch (cause) { failures.push(cause); } };
    attempt(this.cancelGesture); this.downPointers.clear();
    attempt(() => this.detachAbort?.()); attempt(() => this.recording?.dispose()); attempt(() => this.observer?.disconnect());
    attempt(() => this.controls?.removeEventListener("change", this.onCameraChange));
    attempt(() => this.controls?.dispose());
    for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "lostpointercapture"] as const)
      attempt(() => this.canvas?.removeEventListener(type, this.pointerEvent, true));
    attempt(() => this.canvas?.removeEventListener("pointerleave", this.pointerLeave));
    attempt(() => this.canvas?.removeEventListener("keydown", this.key, true));
    attempt(() => this.canvas?.removeEventListener("wheel", this.wheel, true));
    attempt(() => this.canvas?.removeEventListener("blur", this.blur));
    attempt(() => this.canvas?.removeEventListener("webglcontextlost", this.contextLost));
    attempt(() => window.removeEventListener("blur", this.blur));
    for (const resource of this.owned) attempt(() => resource.dispose());
    this.owned.clear(); this.attachedRunoff.clear(); this.scene.clear();
    attempt(() => this.gpu?.dispose()); attempt(() => this.gpu?.forceContextLoss()); attempt(() => this.canvas?.remove());
    if (failures.length) throw new AggregateError(failures, "Liver renderer cleanup failed");
  }
}
